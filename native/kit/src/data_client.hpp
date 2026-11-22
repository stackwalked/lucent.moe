#pragma once

#include <cstddef>
#include <optional>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/session.hpp>

#include "random.hpp"

namespace lucent::kit::detail {

// The module's half of the session's data route (POST /v1/sessions/:id/data), relayed by the host:
// requests sealed module to server, and the server's responses, each accepted only when its
// sequence is above any accepted before. The route's keys and sequences are its own, so lease
// traffic never stales it, nor it the lease. Holds the route's keys until it is destroyed.
//
// One thread at a time: the lifecycle thread opens the session reply's first response, then the
// late-module worker owns it.
class data_client final {
public:
    // Nothing accepted yet: the session reply's first data frame is the first.
    data_client(wire::session_id session, wire::route_keys keys);

    data_client(const data_client&) = delete ("holds the data route's secret keys");
    auto operator=(const data_client&) -> data_client& = delete ("holds secret keys");
    data_client(data_client&&) noexcept = default;
    auto operator=(data_client&&) -> data_client& = delete ("holds secret keys");
    ~data_client() = default;

    // The next request's frame, asking for these module builds, to send now.
    auto request(std::vector<bundle::module_key> modules, random_source& random)
        -> result<std::vector<std::byte>>;

    // A data frame from the server. Malformed or stale unless it is the server's, for this session,
    // newer than any accepted, and opens under the data route's key. A refused frame changes
    // nothing.
    auto accept(const wire::frame& sealed) -> result<wire::data_response>;

private:
    wire::session_id m_session;
    wire::route_keys m_keys;
    std::optional<u64> m_highest_in;
    u64 m_last_out = 0;
};

}
