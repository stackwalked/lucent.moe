#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/kit/session_message.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>

#include "api/server.hpp"

// The loader's half of the module's session (kit/session_message.hpp): the module's hello goes to
// POST /v1/starts/:id/session, each renewal to POST /v1/sessions/:id/lease inside the loader's
// own lease_request, and each data request to POST /v1/sessions/:id/data as it is, every reply
// back to the module unread. A refusal is shown and the module is
// told to unload; an unreachable or troubled server gets no reply, and the module rides it out on
// its lease.

namespace lucent::loader {

// The server calls the relay makes. The loader's is api::server behind the access token; a test
// answers as the server would.
class server_link {
public:
    server_link() = default;
    server_link(const server_link&) = delete ("an interface");
    auto operator=(const server_link&) -> server_link& = delete ("an interface");
    server_link(server_link&&) = delete ("an interface");
    auto operator=(server_link&&) -> server_link& = delete ("an interface");
    virtual ~server_link() = default;

    virtual auto open_session(const wire::start_id& start, std::span<const std::byte> hello)
        -> result<answer> = 0;
    virtual auto renew(const wire::session_id& session, std::span<const std::byte> request)
        -> result<answer> = 0;
    virtual auto fetch_data(const wire::session_id& session, std::span<const std::byte> frame)
        -> result<answer> = 0;
    virtual auto close(const wire::session_id& session) -> result<void> = 0;
};

class relay final {
public:
    explicit relay(wire::start_id start);

    // What goes back to the module for this message: a server_reply, an unload_request after a
    // refusal, or nothing.
    auto on_message(const kit::session_message& message, server_link& link)
        -> std::optional<kit::session_message>;

    // The session the server opened, once it has.
    auto session() const -> std::optional<wire::session_id>;

    // Why the session can't go on, as the server or the module said it; the first one wins.
    auto refused() const -> std::optional<wire::refusal_code>;

private:
    auto on_hello(std::span<const std::byte> hello, server_link& link)
        -> std::optional<kit::session_message>;
    auto on_renewal(std::span<const std::byte> frame, server_link& link)
        -> std::optional<kit::session_message>;
    auto on_data(std::span<const std::byte> frame, server_link& link)
        -> std::optional<kit::session_message>;
    auto refuse(wire::refusal_code code) -> kit::session_message;

    wire::start_id m_start;
    std::optional<wire::session_id> m_session;
    // The last challenge the server gave the loader; answered in the next renewal.
    std::optional<wire::hash_challenge> m_challenge;
    std::optional<wire::refusal_code> m_refused;
};

// Whether a refusal leaves the session to go on: the server's own trouble, its rate limit, a stale
// renewal, or a code this loader doesn't know. Every other refusal unloads the module.
auto is_passing(wire::refusal_code code) -> bool;

// The answer to the server's challenge on the loader's own part of a lease exchange. Zeros until
// hash challenges are designed (wishlist/protection.md, Signals), as the module's answer is; the
// server stores answers unchecked until then.
auto loader_challenge_answer(const wire::hash_challenge& challenge) -> crypto::digest;

}
