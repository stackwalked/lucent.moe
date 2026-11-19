#include <lucent/kit/lifecycle.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <stop_token>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/core_capabilities.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/os/unique_handle.hpp>

#include "dev.hpp"
#include "domain_token_mint.hpp"
#include "late_modules.hpp"
#include "release.hpp"
#include "session_end.hpp"

namespace lucent::kit {
namespace {

auto is_unload(const session_message& message) -> bool {
    return match(
        message,
        [](const dev_text&) { return false; },
        [](const stage_reached&) { return false; },
        [](const unload_request&) { return true; }
    );
}

auto report(session& channel, stage reached) -> void {
    // A failed report means the host is gone; the next receive() sees that and unloads.
    std::ignore = channel.send(stage_reached{.reached = reached});
}

// Returns once the host asks to unload or goes away, or once a kit worker ended the session: its
// cancel makes a pending receive fail, and the mark is checked before each.
auto wait_for_unload(session& channel, const detail::session_end* ending) -> void {
    while (ending == nullptr || !ending->is_requested()) {
        const result<session_message> received = channel.receive();
        // A closed or broken channel means nobody is left to ask: unload.
        if (!received || is_unload(*received)) {
            return;
        }
    }
}

// Far above any real bundle; a size past it is a host bug, not a bundle.
constexpr u64 max_bundle_size = u64{16} << 20U;

struct start_request {
    boot_info info;
    target started;
    // A copy: the host's is borrowed only until the boot entry returns.
    std::vector<std::byte> bundle;
};

// What the resolve stage leaves for the stages after it.
struct resolved {
    // Sets keyed by a module the game hasn't loaded yet.
    waiting_sets waiting;
    // Core capabilities unavailable only for such a module, and those that failed outright.
    std::vector<declared_capability> waiting_core;
    std::vector<u64> failed_core;
};

auto indices_of(std::span<const loaded_module> loaded) -> std::vector<u8> {
    std::vector<u8> indices;
    for (const loaded_module& each : loaded) {
        indices.push_back(each.image.index);
    }
    return indices;
}

// Every linked fact gets its value from the bundle, or stays unresolved. Dev builds report the
// outcome over the dev channel; a release module says nothing.
auto apply_bundle(const start_request& request, std::span<const loaded_module> loaded)
    -> waiting_sets {
    if (request.bundle.empty()) {
        if constexpr (is_dev_build) {
            detail::report_no_bundle();
        }
        return {};
    }
    result<apply_report> applied = apply(
        apply_request{
            .bundle = request.bundle,
            .trusted = request.started.trusted,
            .records = linked_fact_records(),
            .modules = loaded,
        }
    );
    if constexpr (is_dev_build) {
        detail::report_facts(applied);
    }
    if (!applied) {
        return {};
    }
    return std::move(applied->waiting);
}

auto with_keys(std::span<const declared_capability> declared, std::span<const u64> keys)
    -> std::vector<declared_capability> {
    std::vector<declared_capability> kept;
    for (const declared_capability& capability : declared) {
        if (std::ranges::contains(keys, capability.key)) {
            kept.push_back(capability);
        }
    }
    return kept;
}

// The resolve stage, between boot and attach: the bundle applied, then the core capabilities
// judged against the modules loaded now. A capability section that doesn't parse is our own
// image's, and fails the start as a failed core capability would.
auto resolve_stage(const start_request& request) -> result<resolved> {
    const std::vector<loaded_module> loaded = loaded_game_modules(request.started.modules);
    waiting_sets waiting = apply_bundle(request, loaded);
    const std::vector<declared_capability> declared =
        LUCENT_TRY(declared_capabilities(linked_capability_section()));
    const core_judgment judged = judge_core(declared, linked_fact_records(), indices_of(loaded));
    return resolved{
        .waiting = std::move(waiting),
        .waiting_core = with_keys(declared, judged.waiting),
        .failed_core = judged.failed,
    };
}

// Late modules resolve on a kit worker, not on the lifecycle thread, which blocks on the host from
// attach on; workers stop before detach, so no late fact resolves while attach is undone.
auto start_late_worker(worker_set& workers, detail::late_worker handed) -> void {
    // Refused only once the set is stopping, and then nothing is left to resolve for.
    std::ignore = workers.start<"late facts">(
        [late = std::move(handed)](const std::stop_token& stop) mutable {
            detail::resolve_late_modules(stop, *late.signal, std::move(late.facts), late.ending);
        }
    );
}

auto copy_bundle(const boot_info& info) -> result<std::vector<std::byte>> {
    if (info.bundle_size > max_bundle_size || (info.bundle_size != 0 && info.bundle == nullptr)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (info.bundle_size == 0) {
        return std::vector<std::byte>{};
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // the host's stated size
    const std::span<const std::byte> given{info.bundle, narrow<usize>(info.bundle_size)};
#pragma clang diagnostic pop
    return std::vector<std::byte>{given.begin(), given.end()};
}

// Core capabilities may wait for their modules only if their late failure would be seen (a load
// signal) and could end the session; otherwise they count as failed now.
auto give_up_waiting(resolved& resolution) -> void {
    for (const declared_capability& capability : resolution.waiting_core) {
        resolution.failed_core.push_back(capability.key);
    }
    resolution.waiting_core.clear();
}

// A core capability that failed refuses the start: the host sees a start with no attach stage; a
// dev build also says which capabilities, by key.
auto attach_target(
    const start_request& request, const result<resolved>& resolution, worker_set& workers
) -> result<std::unique_ptr<attachment>> {
    if (!resolution) {
        return std::unexpected(resolution.error());
    }
    if (!resolution->failed_core.empty()) {
        if constexpr (is_dev_build) {
            detail::report_refused_start(resolution->failed_core);
        }
        return std::unexpected(error{.code = error_code::unsupported});
    }

    return request.started.attach(workers, detail::domain_token_mint::mint());
}

auto report_waiting_core([[maybe_unused]] const result<resolved>& resolution) -> void {
    if constexpr (is_dev_build) {
        if (resolution && resolution->failed_core.empty() && !resolution->waiting_core.empty()) {
            std::vector<u64> keys;
            for (const declared_capability& capability : resolution->waiting_core) {
                keys.push_back(capability.key);
            }
            detail::report_waiting_core(keys);
        }
    }
}

// Whether the module may be freed: not when detach couldn't show that no thread will run its code
// again.
auto run_stages(session& channel, const start_request& request) -> bool {
    report(channel, stage::boot);
    // Watching before the resolve stage, so a module that loads while it runs still wakes the late
    // worker. Outlives the workers, which wait on it.
    const result<detail::load_signal> signal = detail::load_signal::watch();
    result<resolved> resolution = resolve_stage(request);
    const bool is_waiting =
        resolution && (!resolution->waiting.is_empty() || !resolution->waiting_core.empty());
    if constexpr (is_dev_build) {
        if (!signal && is_waiting) {
            detail::report_no_load_signal(signal.error());
        }
    }
    // How a late core failure ends the session; outlives the workers, which may use it.
    std::optional<detail::session_end> ending;
    if (result<os::unique_handle> thread = detail::current_thread(); thread) {
        ending.emplace(std::move(*thread));
    } else if constexpr (is_dev_build) {
        if (resolution && !resolution->waiting_core.empty()) {
            detail::report_no_session_end(thread.error());
        }
    }
    detail::session_end* const end = ending ? &*ending : nullptr;
    if (resolution && (!signal || end == nullptr)) {
        give_up_waiting(*resolution);
    }
    report_waiting_core(resolution);
    bool is_detached = true;
    {
        worker_set workers;
        // A refused start, or a target that fails to attach, skips straight to detach: the host
        // sees no attach stage.
        const result<std::unique_ptr<attachment>> attached =
            attach_target(request, resolution, workers);
        if (attached && signal && is_waiting) {
            start_late_worker(
                workers,
                detail::late_worker{
                    .signal = &*signal,
                    .ending = end,
                    .facts = detail::late_facts{
                        .waiting = std::move(resolution->waiting),
                        .waiting_core = std::move(resolution->waiting_core),
                        .modules = request.started.modules,
                        .records = linked_fact_records(),
                    },
                }
            );
        }
        if (attached) {
            report(channel, stage::attach);
            report(channel, stage::run);
            wait_for_unload(channel, end);
        }
        // Before detach: hook removal must not race a worker, and counts a running one as busy.
        // Dev builds reported each fault as it happened; release has nowhere to send one yet.
        std::ignore = workers.stop();
        if (attached) {
            is_detached = (*attached)->detach().has_value();
        }
        report(channel, stage::detach);
    }
    if (!is_detached) {
        return false;
    }
    report(channel, stage::unload);
    return true;
}

// Whether the module may be freed, as run_stages decides.
auto run(const start_request& request) -> bool {
    session channel{session_ends{
        .inbound = os::unique_handle{request.info.from_host},
        .outbound = os::unique_handle{request.info.to_host},
    }};
    if constexpr (is_dev_build) {
        detail::publish_dev_session(channel);
    }
    const bool may_free = run_stages(channel, request);
    if constexpr (is_dev_build) {
        detail::withdraw_dev_session();
    }
    return may_free;
}

// A raw thread, the one exception to kit workers: it ends by freeing the module its own code lives
// in, so no object in the module may own it. A static std::jthread would be destroyed during that
// unload and join this very thread.
auto WINAPI lifecycle_main(void* parameter) -> DWORD {
    bool may_free = false;
    image_kind kind = image_kind::loaded;
    u64 trampolines = 0;
    {
        const std::unique_ptr<const start_request> request{
            static_cast<const start_request*>(parameter)
        };
        kind = request->info.kind;
        trampolines = request->info.trampolines;
        may_free = run(*request);
    }
    if (!may_free) {
        // Leaked on purpose: freeing would pull code out from under a thread still in it.
        return 0;
    }
    detail::release_module(kind, trampolines);
}

}

auto start(const boot_info& info, const target& started) -> result<void> {
    LUCENT_INVARIANT(started.attach != nullptr);
    // The host wrote it: an unknown kind is bad input, and releasing by guess would crash later.
    if (info.kind != image_kind::loaded && info.kind != image_kind::mapped) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    auto owned = std::make_unique<start_request>(
        start_request{.info = info, .started = started, .bundle = LUCENT_TRY(copy_bundle(info))}
    );
    // The copy is the module's own; the host's goes away once the boot entry returns.
    owned->info.bundle = nullptr;
    owned->info.bundle_size = 0;
    const os::unique_handle thread{
        CreateThread(nullptr, 0, &lifecycle_main, owned.get(), 0, nullptr)
    };
    if (!thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    // The thread owns it now.
    std::ignore = owned.release();
    return {};
}

}
