#include "session/relay.hpp"

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>

#include "api/server.hpp"
#include "lucent/crypto/crypto.hpp"
#include "lucent/wire/ids.hpp"

namespace lucent::loader {

auto is_passing(wire::refusal_code code) -> bool {
    switch (code) {
    // The server's own trouble (a fault, a deploy, a proxy's error page) or its rate limit: no
    // server for now, which the module rides out inert on its lease and resumes from within the
    // resume window (protection.md, Running).
    case wire::refusal_code::service_unavailable:
    case wire::refusal_code::rate_limited:
    // A stale or replayed renewal is the module's own business: it renews again with the next
    // sequence, and the lease it holds runs on.
    case wire::refusal_code::stale_sequence:
        return true;
    case wire::refusal_code::auth_required:
    case wire::refusal_code::proof_invalid:
    case wire::refusal_code::entitlement_inactive:
    case wire::refusal_code::device_revoked:
    case wire::refusal_code::release_unavailable:
    case wire::refusal_code::channel_not_allowed:
    case wire::refusal_code::account_suspended:
    case wire::refusal_code::not_found:
    case wire::refusal_code::slot_taken:
    case wire::refusal_code::idempotency_conflict:
    case wire::refusal_code::already_enrolled:
    case wire::refusal_code::key_in_use:
    case wire::refusal_code::enrollment_limit:
    case wire::refusal_code::start_mismatch:
    case wire::refusal_code::session_ended:
    case wire::refusal_code::start_expired:
    case wire::refusal_code::invalid_request:
    case wire::refusal_code::game_build_unsupported:
    case wire::refusal_code::game_update_required:
    case wire::refusal_code::loader_update_required:
        return false;
    }
    // A code this loader doesn't know is the server's to explain; the module's lease decides.
    return true;
}

relay::relay(wire::start_id start)
    : m_start{start} {}

auto relay::session() const -> std::optional<wire::session_id> {
    return m_session;
}

auto relay::refused() const -> std::optional<wire::refusal_code> {
    return m_refused;
}

auto relay::refuse(wire::refusal_code code) -> kit::session_message {
    if (!m_refused) {
        m_refused = code;
    }
    return kit::unload_request{};
}

auto relay::on_message(const kit::session_message& message, server_link& link)
    -> std::optional<kit::session_message> {
    return match(
        message,
        [this, &link](const kit::server_request& asked) -> std::optional<kit::session_message> {
            switch (asked.route) {
            case kit::server_route::session:
                return on_hello(asked.body, link);
            case kit::server_route::lease:
                return on_renewal(asked.body, link);
            }
            return std::nullopt;
        },
        [this](const kit::start_refused& refused) -> std::optional<kit::session_message> {
            // The module stops itself after saying so; nothing to answer.
            if (!m_refused) {
                m_refused = refused.code;
            }
            return std::nullopt;
        },
        [](const auto&) -> std::optional<kit::session_message> { return std::nullopt; }
    );
}

auto relay::on_hello(std::span<const std::byte> hello, server_link& link)
    -> std::optional<kit::session_message> {
    // One session per start: the module says hello once.
    if (m_session) {
        return std::nullopt;
    }
    const result<answer> answered = link.open_session(m_start, hello);
    if (!answered) {
        return std::nullopt;
    }
    if (const std::optional<wire::refusal> refused = refusal_in(*answered)) {
        return is_passing(refused->code) ? std::nullopt : std::optional{refuse(refused->code)};
    }
    const std::span<const std::byte> body = body_in(*answered);
    // The loader reads only the session's id, which the next renewals are addressed to; the module
    // verifies the exchange's signature itself.
    const result<wire::session_reply> reply = wire::decode_session_reply(body);
    if (!reply) {
        return std::nullopt;
    }
    m_session = reply->exchange.session;
    return kit::server_reply{
        .route = kit::server_route::session,
        .body = std::vector<std::byte>{body.begin(), body.end()},
    };
}

auto relay::on_renewal(std::span<const std::byte> frame, server_link& link)
    -> std::optional<kit::session_message> {
    if (!m_session) {
        return std::nullopt;
    }
    const result<wire::frame> renewal = wire::decode_frame(frame);
    if (!renewal) {
        return std::nullopt;
    }
    std::optional<crypto::digest> answer_to_challenge;
    if (m_challenge) {
        answer_to_challenge = loader_challenge_answer(*m_challenge);
    }
    const std::vector<std::byte> request = wire::encode_lease_request(
        wire::lease_request{.loader_answer = answer_to_challenge, .renewal = *renewal}
    );
    const result<answer> answered = link.renew(*m_session, request);
    if (!answered) {
        return std::nullopt;
    }
    if (const std::optional<wire::refusal> refused = refusal_in(*answered)) {
        return is_passing(refused->code) ? std::nullopt : std::optional{refuse(refused->code)};
    }
    const result<wire::lease_response> response = wire::decode_lease_response(body_in(*answered));
    if (!response) {
        return std::nullopt;
    }
    m_challenge = response->loader_challenge;
    return kit::server_reply{
        .route = kit::server_route::lease,
        .body = wire::encode_frame(response->lease),
    };
}

auto loader_challenge_answer(const wire::hash_challenge& /*challenge*/) -> crypto::digest {
    return crypto::digest{};
}

}
