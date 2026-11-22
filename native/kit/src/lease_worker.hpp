#pragma once

#include <cstddef>
#include <stop_token>
#include <vector>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/session.hpp>

#include "data_client.hpp"
#include "frame_inbox.hpp"
#include "lease_client.hpp"
#include "random.hpp"
#include "release.hpp"
#include "session_end.hpp"

namespace lucent::kit::detail {

// What the hello leaves: the client holding the session, the first lease's grant, the data route,
// and the first bundle, which the session reply carries.
struct opened_lease {
    lease_client client;
    entitlements entitled;
    data_client data;
    std::vector<std::byte> bundle;
};

// This module as its hello describes it: its release, its image, and the compiled-in lease key.
// Release builds only, which have both ids.
auto own_identity(const boot_info& info, const own_image& image) -> lease_identity;

// The hello, relayed by the host, and the server's reply with the first lease and data; the
// lifecycle thread, before attach. Fails as closed when the host asked to unload or went away
// before the reply came.
auto open_lease(
    session& channel, const lease_identity& identity, const clock& time, random_source& random
) -> result<opened_lease>;

// What the lease worker runs with; every pointer outlives the worker set it runs in.
struct lease_run {
    lease_client client;
    entitlements entitled;
    frame_inbox* inbox = nullptr;
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
