#include "late_modules.hpp"

#include <algorithm>
#include <bit>
#include <chrono>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <stop_token>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/core_capabilities.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/os/unique_handle.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/refusal.hpp>

#include "dev.hpp"
#include "session_end.hpp"

// build: Windows 10.0.26100; ntdll has exported both since Windows Vista, but neither the SDK's
//        headers nor its ntdll.lib carry them, so they're looked up by name.
// found: documented on Microsoft Learn ("LdrRegisterDllNotification function", "LdrDllNotification
//        callback function"): flags must be 0; the callback gets the reason, the DLL's data and our
//        context; a reason of 1 is LDR_DLL_NOTIFICATION_REASON_LOADED.
// breaks: if ntdll drops them, watch() fails and late modules stay unavailable; another reason
//         value would wake the worker for nothing, or never.
using dll_notification_fn = void(__stdcall*)(ULONG reason, const void* data, void* context);
using register_fn = auto(__stdcall*)(
    ULONG flags, dll_notification_fn notify, void* context, void** cookie
) -> LONG;

namespace lucent::kit::detail {
namespace {

constexpr ULONG dll_loaded = 1;

// How long a worker waiting for a load takes at most to see a stop. A stop callback could wake it
// at once, but a contained fault skips the frame that would unregister one.
constexpr std::chrono::milliseconds stop_patience{100};

auto ntdll_function(const char* name) -> result<uptr> {
    const auto address = std::bit_cast<uptr>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), name));
    if (address == 0) {
        return std::unexpected(last_system_error());
    }
    return address;
}

// The loader calls this on the thread loading a DLL, under its lock.
auto __stdcall on_dll_notification(ULONG reason, const void* /*data*/, void* loaded) noexcept
    -> void {
    if (reason == dll_loaded) {
        SetEvent(loaded);
    }
}

}

load_signal::load_signal(os::unique_handle loaded, void* cookie, unregister_fn unregister)
    : m_loaded{std::move(loaded)}
    , m_cookie{cookie}
    , m_unregister{unregister} {}

load_signal::load_signal(load_signal&& other) noexcept
    : m_loaded{std::move(other.m_loaded)}
    , m_cookie{std::exchange(other.m_cookie, nullptr)}
    , m_unregister{other.m_unregister} {}

load_signal::~load_signal() {
    if (m_cookie != nullptr) {
        // Fails only for a cookie it never issued.
        std::ignore = m_unregister(m_cookie);
    }
}

auto load_signal::watch() -> result<load_signal> {
    // Auto-reset: one wake covers every load since the last, and the worker rescans them all.
    os::unique_handle loaded{CreateEventW(nullptr, FALSE, FALSE, nullptr)};
    if (!loaded.is_valid()) {
        return std::unexpected(last_system_error());
    }
    const auto register_notification =
        std::bit_cast<register_fn>(LUCENT_TRY(ntdll_function("LdrRegisterDllNotification")));
    const auto unregister =
        std::bit_cast<unregister_fn>(LUCENT_TRY(ntdll_function("LdrUnregisterDllNotification")));
    void* cookie = nullptr;
    const LONG status = register_notification(0, &on_dll_notification, loaded.native(), &cookie);
    if (status < 0) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(status)}
        );
    }
    return load_signal{std::move(loaded), cookie, unregister};
}

auto load_signal::wait(const std::stop_token& stop) const -> void {
    const auto patience = static_cast<DWORD>(stop_patience.count());
    while (!stop.stop_requested()) {
        if (WaitForSingleObject(m_loaded.native(), patience) == WAIT_OBJECT_0) {
            return;
        }
    }
}

namespace {

auto indices_of(std::span<const loaded_module> loaded) -> std::vector<u8> {
    std::vector<u8> indices;
    for (const loaded_module& each : loaded) {
        indices.push_back(each.image.index);
    }
    return indices;
}

auto still_waiting(std::vector<declared_capability> core, std::span<const u64> waiting)
    -> std::vector<declared_capability> {
    std::erase_if(core, [&](const declared_capability& capability) {
        return !std::ranges::contains(waiting, capability.key);
    });
    return core;
}

// One data request for these builds, and the response the host relays back; nothing once the
// patience runs out, stop is requested, or the request couldn't go out. A frame that doesn't check
// out is the host's or the network's noise, as on the lease route: dropped, and the wait goes on.
auto fetch(
    const std::stop_token& stop, const data_link& link, std::vector<bundle::module_key> builds
) -> std::optional<wire::data_response> {
    const result<std::vector<std::byte>> body =
        link.client->request(std::move(builds), *link.random);
    if (!body
        || !link.channel->send(server_request{.route = server_route::data, .body = *body})
            .has_value()) {
        return std::nullopt;
    }
    const clock::time_point deadline = link.time->now() + data_patience;
    while (!stop.stop_requested()) {
        const clock::time_point now = link.time->now();
        if (now >= deadline) {
            return std::nullopt;
        }
        const std::optional<std::vector<std::byte>> frame = link.inbox->wait(stop, deadline - now);
        if (!frame) {
            continue;
        }
        const result<wire::frame> sealed = wire::decode_frame(*frame);
        if (!sealed) {
            continue;
        }
        result<wire::data_response> response = link.client->accept(*sealed);
        if (response) {
            return std::move(*response);
        }
    }
    return std::nullopt;
}

// The unasked modules loaded now leave the list whatever the answer: one request per load. What
// comes back waits with the other sets; release says nothing of a set it drops or of a build the
// server has none for, as the boot resolve doesn't.
auto ask_for_loaded(
    const std::stop_token& stop,
    const data_link& link,
    late_facts& late,
    std::span<const loaded_module> loaded
) -> void {
    std::vector<bundle::module_key> builds;
    for (const loaded_module& each : loaded) {
        if (std::ranges::contains(late.unasked, each.image.index)) {
            builds.push_back(each.build);
            std::erase(late.unasked, each.image.index);
        }
    }
    if (builds.empty()) {
        return;
    }
    const std::optional<wire::data_response> response = fetch(stop, link, std::move(builds));
    if (!response) {
        return;
    }
    std::ignore = late.waiting.admit(
        admit_request{
            .bundle = response->bundle_bytes,
            .trusted = late.trusted,
            .records = late.records,
        }
    );
}

auto is_left(const late_worker& worker) -> bool {
    const late_facts& late = worker.facts;
    return !late.waiting.is_empty()
           || !late.waiting_core.empty()
           || (worker.data != nullptr && !late.unasked.empty());
}

}

auto resolve_late_modules(const std::stop_token& stop, late_worker worker) -> void {
    late_facts& late = worker.facts;
    // Waits before the first scan: the signal watched from before the boot resolve, so a module
    // loaded since that scan has already set it, and one loaded before was in that scan.
    while (is_left(worker)) {
        worker.signal->wait(stop);
        if (stop.stop_requested()) {
            return;
        }
        const std::vector<loaded_module> loaded = loaded_game_modules(late.modules);
        // Before the waiting sets apply and the core is judged: a core capability of a module that
        // just loaded must see its set first.
        if (worker.data != nullptr) {
            ask_for_loaded(stop, *worker.data, late, loaded);
        }
        if (!late.waiting.is_empty()) {
            const late_report report =
                late.waiting.apply_loaded(late_request{.records = late.records, .modules = loaded});
            if constexpr (is_dev_build) {
                if (!report.sets.empty()) {
                    report_late_facts(report);
                }
            }
        }
        if (late.waiting_core.empty()) {
            continue;
        }
        const core_judgment judged =
            judge_core(late.waiting_core, late.records, indices_of(loaded));
        if (!judged.failed.empty()) {
            if constexpr (is_dev_build) {
                report_late_core_failed(judged.failed);
            }
            // The start went on only with a way to end the session.
            LUCENT_INVARIANT(worker.ending != nullptr);
            worker.ending->request(stop, wire::refusal_code::game_build_unsupported);
            return;
        }
        late.waiting_core = still_waiting(std::move(late.waiting_core), judged.waiting);
    }
}

}
