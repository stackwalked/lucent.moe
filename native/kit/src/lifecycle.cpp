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

#include <lucent/core/narrow.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/core_capabilities.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_apply.hpp>
#include <lucent/kit/game_module.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/os/unique_handle.hpp>
#include <lucent/wire/refusal.hpp>

#include "dev.hpp"
#include "domain_token_mint.hpp"
#include "frame_inbox.hpp"
#include "late_modules.hpp"
#include "lease_client.hpp"
#include "lease_worker.hpp"
#include "random.hpp"
#include "release.hpp"
#include "session_end.hpp"

namespace lucent::kit {
namespace {

auto report(session& channel, stage reached) -> void {
    // A failed report means the host is gone; the next receive() sees that and unloads.
    std::ignore = channel.send(stage_reached{.reached = reached});
}

auto refuse(session& channel, wire::refusal_code code) -> void {
    // As for a report: the next receive() sees a host that's gone.
    std::ignore = channel.send(start_refused{.code = code});
}

// Where the frames the host relays back go: each route's to the worker that owns its client. Null
// without a session (a dev build, or a release start that opened none).
struct inboxes {
    detail::frame_inbox* lease = nullptr;
    detail::frame_inbox* data = nullptr;
};

auto deliver(const session_message& received, server_route route, detail::frame_inbox* inbox)
    -> void {
    if (std::optional<std::vector<std::byte>> body = reply_body(received, route);
        body && inbox != nullptr) {
        inbox->push(std::move(*body));
    }
}

// Returns once the host asks to unload or goes away, or once a kit worker ended the session: its
// cancel makes a pending receive fail, and the mark is checked before each.
auto wait_for_unload(session& channel, const detail::session_end* ending, const inboxes& relayed)
    -> void {
    while (ending == nullptr || !ending->is_requested()) {
        const result<session_message> received = channel.receive();
        // A closed or broken channel means nobody is left to ask: unload.
        if (!received || is_unload_request(*received)) {
            return;
        }
        deliver(*received, server_route::lease, relayed.lease);
        deliver(*received, server_route::data, relayed.data);
    }
}

// Far above any real bundle; a size past it is a host bug, not a bundle.
constexpr u64 max_bundle_size = u64{16} << 20U;

struct start_request {
    boot_info info;
    detail::own_image image;
    target started;
    // A copy: the host's is borrowed only until the boot entry returns. Only a dev build applies
    // it; a release module's comes with its session.
    std::vector<std::byte> bundle;
};

// What the resolve stage leaves for the stages after it.
struct resolved {
    // Sets keyed by a module the game hasn't loaded yet.
    waiting_sets waiting;
    // Core capabilities unavailable only for such a module, and those that failed outright.
    std::vector<declared_capability> waiting_core;
    std::vector<u64> failed_core;
    // The known modules not loaded now, whose sets a release module asks for once they load.
    std::vector<u8> unloaded;
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
auto apply_bundle(
    const start_request& request,
    std::span<const std::byte> bundle,
    std::span<const loaded_module> loaded
) -> waiting_sets {
    if (bundle.empty()) {
        if constexpr (is_dev_build) {
            detail::report_no_bundle();
        }
        return {};
    }
    result<apply_report> applied = apply(
        apply_request{
            .bundle = bundle,
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

auto index_of(const loaded_module& loaded) -> u8 {
    return loaded.image.index;
}

auto unloaded_of(std::span<const game_module> known, std::span<const loaded_module> loaded)
    -> std::vector<u8> {
    std::vector<u8> unloaded;
    for (const game_module& module : known) {
        if (!std::ranges::contains(loaded, module.index, index_of)) {
            unloaded.push_back(module.index);
        }
    }
    return unloaded;
}

// The resolve stage, between boot and attach and after the session opened: the bundle applied (a
// release module's from the session reply, a dev module's from the host), then the core
// capabilities judged against the modules loaded now. A capability section that doesn't parse is
// our own image's, and fails the start as a failed core capability would.
auto resolve_stage(const start_request& request, std::span<const std::byte> bundle)
    -> result<resolved> {
    const std::vector<loaded_module> loaded = loaded_game_modules(request.started.modules);
    waiting_sets waiting = apply_bundle(request, bundle, loaded);
    const std::vector<declared_capability> declared =
        LUCENT_TRY(declared_capabilities(linked_capability_section()));
    const core_judgment judged = judge_core(declared, linked_fact_records(), indices_of(loaded));
    return resolved{
        .waiting = std::move(waiting),
        .waiting_core = with_keys(declared, judged.waiting),
        .failed_core = judged.failed,
        .unloaded = unloaded_of(request.started.modules, loaded),
    };
}

// Late modules resolve on a kit worker, not on the lifecycle thread, which blocks on the host from
// attach on; workers stop before detach, so no late fact resolves while attach is undone.
auto start_late_worker(worker_set& workers, detail::late_worker handed) -> void {
    // Refused only once the set is stopping, and then nothing is left to resolve for.
    std::ignore = workers.start<"late facts">(
        [late = std::move(handed)](const std::stop_token& stop) mutable {
            detail::resolve_late_modules(stop, std::move(late));
        }
    );
}

// The lease's grant reaches the registry before the target's first tick; then the worker renews.
auto start_lease_worker(worker_set& workers, detail::lease_run handed) -> result<void> {
    handed.features->request({replace_entitlements{.entitled = handed.entitled}});
    return workers.start<"lease">([run = std::move(handed)](const std::stop_token& stop) mutable {
        detail::run_lease(stop, std::move(run));
    });
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

// What the host is told when attach isn't reached: a core capability that failed means this game
// build isn't covered; anything else is ours, and says only that the start couldn't be served.
auto refusal_of(const result<resolved>& resolution) -> wire::refusal_code {
    if (resolution && !resolution->failed_core.empty()) {
        return wire::refusal_code::game_build_unsupported;
    }
    return wire::refusal_code::service_unavailable;
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

// Whether the resolve stage left anything for a module the game hasn't loaded yet.
auto is_waiting_on_modules(const result<resolved>& resolution) -> bool {
    return resolution && (!resolution->waiting.is_empty() || !resolution->waiting_core.empty());
}

// Whether the late worker has anything to do: with a session, any module not loaded yet has its
// set to be asked for.
auto is_left_for_late(
    const result<resolved>& resolution, const std::optional<detail::opened_lease>& lease
) -> bool {
    return is_waiting_on_modules(resolution)
           || (lease.has_value() && resolution && !resolution->unloaded.empty());
}

// Dev builds say when a module that loads later would go unnoticed.
auto report_unwatched(
    [[maybe_unused]] const result<detail::load_signal>& signal,
    [[maybe_unused]] const result<resolved>& resolution
) -> void {
    if constexpr (is_dev_build) {
        if (!signal && is_waiting_on_modules(resolution)) {
            detail::report_no_load_signal(signal.error());
        }
    }
}

// What a release build's lease and late workers borrow; each outlives the worker set.
struct lease_start {
    std::optional<detail::opened_lease>* lease = nullptr;
    detail::frame_inbox* inbox = nullptr;
    detail::frame_inbox* data_inbox = nullptr;
    session* channel = nullptr;
    const clock* time = nullptr;
    detail::random_source* random = nullptr;
    detail::session_end* ending = nullptr;
};

// The lease's grant before anything ticks, and its worker from then on; nothing to do without a
// lease (a dev build). A worker that won't start would leave nothing to notice the lease end, so
// the session doesn't run.
auto start_running(worker_set& workers, attachment& attached, const lease_start& with)
    -> result<void> {
    if (!with.lease->has_value()) {
        return {};
    }
    detail::opened_lease& opened = **with.lease;
    return start_lease_worker(
        workers,
        detail::lease_run{
            .client = std::move(opened.client),
            .entitled = opened.entitled,
            .inbox = with.inbox,
            .channel = with.channel,
            .features = &attached.features(),
            .time = with.time,
            .random = with.random,
            .ending = with.ending,
        }
    );
}

// The late worker's way to the server, when there is a session: nothing in a dev build. Its client
// stays in the opened lease.
auto data_link_of(const lease_start& with) -> std::optional<detail::data_link> {
    if (!with.lease->has_value()) {
        return std::nullopt;
    }
    return detail::data_link{
        .client = &(*with.lease)->data,
        .inbox = with.data_inbox,
        .channel = with.channel,
        .time = with.time,
        .random = with.random,
    };
}

auto inboxes_of(const lease_start& with) -> inboxes {
    if (!with.lease->has_value()) {
        return {};
    }
    return inboxes{.lease = with.inbox, .data = with.data_inbox};
}

// A release build runs only under a lease, opened before the resolve stage, whose reply also
// brings the first bundle; dev builds have no server and hold none.
auto lease_for(
    session& channel, const start_request& request, const clock& time, detail::random_source& random
) -> std::optional<detail::opened_lease> {
    if constexpr (is_dev_build) {
        return std::nullopt;
    } else {
        const detail::lease_identity identity = detail::own_identity(request.info, request.image);
        result<detail::opened_lease> opened = detail::open_lease(channel, identity, time, random);
        if (!opened) {
            return std::nullopt;
        }
        return std::move(*opened);
    }
}

// The bundle the resolve stage applies: the session reply's in release (none without a session),
// the host's in dev.
auto boot_bundle(const start_request& request, const std::optional<detail::opened_lease>& lease)
    -> std::span<const std::byte> {
    if constexpr (is_dev_build) {
        return request.bundle;
    } else if (lease) {
        return lease->bundle;
    }
    return {};
}

// The attached run: the host sees attach and run, then the end, with its reason when a worker
// asked for it (a core capability that failed once its module loaded, or a lease that ran out).
auto run_until_unload(session& channel, const detail::session_end* end, const inboxes& relayed)
    -> void {
    report(channel, stage::attach);
    report(channel, stage::run);
    wait_for_unload(channel, end, relayed);
    if (end != nullptr && end->is_requested()) {
        refuse(channel, end->reason());
    }
}

// Whether the module may be freed: not when detach couldn't show that no thread will run its code
// again.
auto run_stages(session& channel, const start_request& request) -> bool {
    report(channel, stage::boot);
    // What the lease worker borrows; all outlive the workers.
    const monotonic_clock time;
    detail::system_random random;
    detail::frame_inbox leases;
    detail::frame_inbox data_frames;
    std::optional<detail::opened_lease> lease = lease_for(channel, request, time, random);
    const bool is_leased = is_dev_build || lease.has_value();
    // Watching before the resolve stage, so a module that loads while it runs still wakes the late
    // worker. Outlives the workers, which wait on it.
    const result<detail::load_signal> signal = detail::load_signal::watch();
    result<resolved> resolution = resolve_stage(request, boot_bundle(request, lease));
    const bool is_waiting = is_left_for_late(resolution, lease);
    report_unwatched(signal, resolution);
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
    // A lease that lapses for good must be able to end the session.
    const bool may_attach = is_leased && (is_dev_build || end != nullptr);
    report_waiting_core(resolution);
    const lease_start with{
        .lease = &lease,
        .inbox = &leases,
        .data_inbox = &data_frames,
        .channel = &channel,
        .time = &time,
        .random = &random,
        .ending = end,
    };
    std::optional<detail::data_link> data = data_link_of(with);
    bool is_detached = true;
    {
        worker_set workers;
        // A refused start, a release start without a lease, or a target that fails to attach,
        // skips straight to detach: the host sees no attach stage.
        const result<std::unique_ptr<attachment>> attached =
            may_attach ? attach_target(request, resolution, workers)
                       : std::unexpected(error{.code = error_code::unsupported});
        const bool is_running = attached && start_running(workers, **attached, with).has_value();
        if (attached && signal && is_waiting) {
            start_late_worker(
                workers,
                detail::late_worker{
                    .signal = &*signal,
                    .ending = end,
                    .data = data.has_value() ? &*data : nullptr,
                    .facts = detail::late_facts{
                        .waiting = std::move(resolution->waiting),
                        .waiting_core = std::move(resolution->waiting_core),
                        .unasked = std::move(resolution->unloaded),
                        .modules = request.started.modules,
                        .records = linked_fact_records(),
                        .trusted = request.started.trusted,
                    },
                }
            );
        }
        if (is_running) {
            run_until_unload(channel, end, inboxes_of(with));
        } else {
            refuse(
                channel,
                is_leased ? refusal_of(resolution) : wire::refusal_code::service_unavailable
            );
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
    detail::own_image image;
    {
        const std::unique_ptr<const start_request> request{
            static_cast<const start_request*>(parameter)
        };
        image = request->image;
        may_free = run(*request);
    }
    if (!may_free) {
        // Leaked on purpose: freeing would pull code out from under a thread still in it.
        return 0;
    }
    detail::release_module(image);
}

}

auto start(const boot_info& info, const target& started) -> result<void> {
    LUCENT_INVARIANT(started.attach != nullptr);
    std::vector<std::byte> bundle = LUCENT_TRY(copy_bundle(info));
    const detail::own_image image = LUCENT_TRY(detail::adopt_image(info));
    auto owned = std::make_unique<start_request>(start_request{
        .info = info,
        .image = image,
        .started = started,
        .bundle = std::move(bundle),
    });
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
