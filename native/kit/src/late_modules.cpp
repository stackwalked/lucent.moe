#include "late_modules.hpp"

#include <bit>
#include <chrono>
#include <expected>
#include <stop_token>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/os/unique_handle.hpp>

#include "dev.hpp"

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

auto resolve_late_modules(const std::stop_token& stop, const load_signal& signal, late_facts late)
    -> void {
    // Waits before the first scan: the signal watched from before the boot resolve, so a module
    // loaded since that scan has already set it, and one loaded before was in that scan.
    while (!late.waiting.is_empty()) {
        signal.wait(stop);
        if (stop.stop_requested()) {
            return;
        }
        const std::vector<loaded_module> loaded = loaded_game_modules(late.modules);
        const late_report report =
            late.waiting.apply_loaded(late_request{.records = late.records, .modules = loaded});
        if constexpr (is_dev_build) {
            if (!report.sets.empty()) {
                report_late_facts(report);
            }
        }
    }
}

}
