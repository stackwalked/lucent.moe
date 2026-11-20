#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <stop_token>
#include <vector>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/session.hpp>

#include "lease_client.hpp"
#include "random.hpp"
#include "release.hpp"
#include "session_end.hpp"

namespace lucent::kit::detail {

// Lease frames the host relayed, from the lifecycle thread, which reads the session, to the lease
// worker, which owns the client.
class lease_inbox final {
public:
    lease_inbox() = default;

    lease_inbox(const lease_inbox&) = delete ("both threads hold its address");
    auto operator=(const lease_inbox&) -> lease_inbox& = delete ("both threads hold its address");
    lease_inbox(lease_inbox&&) = delete ("both threads hold its address");
    auto operator=(lease_inbox&&) -> lease_inbox& = delete ("both threads hold its address");
    ~lease_inbox() = default;

    // The lifecycle thread. Past the bound the oldest frame goes: a host flooding the module can't
    // make it allocate without end, and only the newest lease matters.
    auto push(std::vector<std::byte> frame) -> void;

    // The lease worker: the oldest frame waiting, or nothing once `timeout` passed or stop was
    // requested.
    auto wait(const std::stop_token& stop, std::chrono::nanoseconds timeout)
        -> std::optional<std::vector<std::byte>>;

private:
    static constexpr isize max_frames = 64;

    std::mutex m_lock;
    std::condition_variable_any m_arrived;
    std::vector<std::vector<std::byte>> m_frames;
};

// What the hello leaves: the client holding the session, and the first lease's grant.
struct opened_lease {
    lease_client client;
    entitlements entitled;
};

// This module as its hello describes it: its release, its image, and the compiled-in lease key.
// Release builds only, which have both ids.
auto own_identity(const boot_info& info, const own_image& image) -> lease_identity;

// The hello, relayed by the host, and the server's reply with the first lease; the lifecycle
// thread, before attach. Fails as closed when the host asked to unload or went away before the
// reply came.
auto open_lease(
    session& channel, const lease_identity& identity, const clock& time, random_source& random
) -> result<opened_lease>;

// What the lease worker runs with; every pointer outlives the worker set it runs in.
struct lease_run {
    lease_client client;
    entitlements entitled;
    lease_inbox* inbox = nullptr;
    session* channel = nullptr;
    registry* features = nullptr;
    const clock* time = nullptr;
    random_source* random = nullptr;
    session_end* ending = nullptr;
};

// Renews on the interval, applies each lease the host relays back (a changed grant, a resume after
// a lapse), stops every feature when the lease lapses, and ends the session with SESSION_ENDED
// once the resume window has passed. Returns when stop is requested; the client, and with it the
// session keys, is destroyed then.
auto run_lease(const std::stop_token& stop, lease_run run) -> void;

}
