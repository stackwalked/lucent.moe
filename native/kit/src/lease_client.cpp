#include "lease_client.hpp"

#include <algorithm>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/session.hpp>

#include "data_client.hpp"
#include "random.hpp"

namespace lucent::kit::detail {
namespace {

constexpr error malformed{.code = error_code::malformed};

}

auto entitlements_of(const wire::entitled_features& granted) -> entitlements {
    entitlements entitled{.is_everything = granted.is_everything, .features = {}};
    for (const u64 feature : granted.features) {
        entitled.features.push_back(static_cast<feature_id>(feature));
    }
    return entitled;
}

lease_client::lease_client(
    lease_identity identity, crypto::exchange_key key, wire::module_nonce nonce
)
    : m_identity{identity}
    , m_key{std::move(key)}
    , m_hello_nonce{nonce} {}

auto lease_client::create(const lease_identity& identity, random_source& random)
    -> result<lease_client> {
    crypto::seed material{};
    LUCENT_TRY(random.fill(material));
    crypto::exchange_key key = crypto::exchange_key::from_seed(material);
    crypto::wipe(material);
    wire::module_nonce nonce{};
    LUCENT_TRY(random.fill(nonce));
    return lease_client{identity, std::move(key), nonce};
}

auto lease_client::hello() const -> std::vector<std::byte> {
    return wire::encode_session_hello(
        wire::session_hello{
            .module_key = m_key.public_part(),
            .nonce = m_hello_nonce,
            .release = m_identity.release,
            .boot = m_identity.boot,
        }
    );
}

auto lease_client::open(std::span<const std::byte> reply, clock::time_point sent)
    -> result<session_opening> {
    LUCENT_INVARIANT(!m_session.has_value());
    const wire::session_reply decoded = LUCENT_TRY(wire::decode_session_reply(reply));
    const wire::session_exchange& exchange = decoded.exchange;
    LUCENT_TRY(wire::verify_session_exchange(exchange, m_identity.lease_key));
    // The signature binds the server's half to the module key and nonce it echoes; they must be
    // this hello's, or a recorded exchange could open a session here.
    if (exchange.module_key != m_key.public_part() || exchange.nonce != m_hello_nonce) {
        return std::unexpected(malformed);
    }
    const crypto::secret_key shared = LUCENT_TRY(m_key.shared_secret(exchange.server_key));
    wire::session_keys keys = wire::derive_session_keys(
        shared,
        wire::exchange_halves{
            .module_key = m_key.public_part(),
            .server_key = exchange.server_key,
        }
    );
    const wire::frame& first = decoded.first_lease;
    if (first.header.way != wire::direction::server_to_module
        || first.header.session != exchange.session) {
        return std::unexpected(malformed);
    }
    const crypto::secret_bytes plain =
        LUCENT_TRY(wire::open_frame(keys.lease.server_to_module, first));
    const wire::lease granted = LUCENT_TRY(wire::decode_lease(plain.as_bytes()));
    LUCENT_TRY(wire::verify_lease(granted, m_identity.lease_key));
    if (granted.session != exchange.session
        || granted.nonce != m_hello_nonce
        || granted.release != m_identity.release) {
        return std::unexpected(malformed);
    }
    data_client data{exchange.session, std::move(keys.data)};
    wire::data_response first_data = LUCENT_TRY(data.accept(decoded.first_data));
    m_session.emplace(
        session_state{
            .keys = std::move(keys.lease),
            .held = granted,
            .expires = sent + granted.duration,
            .highest_in = first.header.sequence,
            .last_out = 0,
            .last_renewal = sent,
            .pending = {},
        }
    );
    return session_opening{
        .entitled = entitlements_of(granted.entitled),
        .data = std::move(data),
        .first_data = std::move(first_data),
    };
}

auto lease_client::renewal(clock::time_point now, random_source& random)
    -> result<std::vector<std::byte>> {
    LUCENT_INVARIANT(m_session.has_value());
    session_state& session = *m_session;
    wire::module_nonce nonce{};
    LUCENT_TRY(random.fill(nonce));
    crypto::aead_nonce frame_nonce{};
    LUCENT_TRY(random.fill(frame_nonce));
    // Hash challenges are phase 6's (wishlist, "the walls"): until then the answer is zeros, which
    // the server stores and never checks, and the signals are unassigned.
    const std::vector<std::byte> plain = wire::encode_lease_renewal(
        wire::lease_renewal{
            .sequence = session.held.sequence + 1,
            .nonce = nonce,
            .challenge_answer = {},
            .signals = {},
        }
    );
    const u64 sequence = session.last_out + 1;
    const wire::frame sealed = wire::seal_frame(
        session.keys.module_to_server,
        wire::frame_contents{
            .header =
                wire::frame_header{
                    .session = session.held.session,
                    .way = wire::direction::module_to_server,
                    .sequence = sequence,
                },
            .nonce = frame_nonce,
            .plain = plain,
        }
    );
    session.last_out = sequence;
    session.last_renewal = now;
    session.pending.push_back(pending_renewal{.nonce = nonce, .sent = now});
    if (std::ssize(session.pending) > max_pending_renewals) {
        session.pending.erase(session.pending.begin());
    }
    return wire::encode_frame(sealed);
}

auto lease_client::accept(std::span<const std::byte> frame) -> result<entitlements> {
    LUCENT_INVARIANT(m_session.has_value());
    session_state& session = *m_session;
    const wire::frame sealed = LUCENT_TRY(wire::decode_frame(frame));
    // A replayed or reordered frame is refused before it is opened, as frame.hpp says.
    if (sealed.header.way != wire::direction::server_to_module
        || sealed.header.session != session.held.session
        || sealed.header.sequence <= session.highest_in) {
        return std::unexpected(malformed);
    }
    const crypto::secret_bytes plain =
        LUCENT_TRY(wire::open_frame(session.keys.server_to_module, sealed));
    const wire::lease granted = LUCENT_TRY(wire::decode_lease(plain.as_bytes()));
    LUCENT_TRY(wire::verify_lease(granted, m_identity.lease_key));
    if (granted.session != session.held.session
        || granted.device != session.held.device
        || granted.release != session.held.release
        || granted.sequence != session.held.sequence + 1) {
        return std::unexpected(malformed);
    }
    const auto answered =
        std::ranges::find(session.pending, granted.nonce, &pending_renewal::nonce);
    if (answered == session.pending.end()) {
        return std::unexpected(malformed);
    }
    session.expires = answered->sent + granted.duration;
    session.held = granted;
    session.highest_in = sealed.header.sequence;
    session.pending.clear();
    return entitlements_of(granted.entitled);
}

auto lease_client::standing(clock::time_point now) const -> lease_standing {
    LUCENT_INVARIANT(m_session.has_value());
    if (now < m_session->expires) {
        return lease_standing::held;
    }
    if (now < m_session->expires + resume_window) {
        return lease_standing::lapsed;
    }
    return lease_standing::ended;
}

auto lease_client::is_renewal_due(clock::time_point now) const -> bool {
    LUCENT_INVARIANT(m_session.has_value());
    return now >= m_session->last_renewal + renewal_interval;
}

auto lease_client::next_change(clock::time_point now) const -> clock::time_point {
    LUCENT_INVARIANT(m_session.has_value());
    clock::time_point soonest = m_session->last_renewal + renewal_interval;
    for (const clock::time_point edge : {m_session->expires, m_session->expires + resume_window}) {
        if (edge > now) {
            soonest = std::min(soonest, edge);
        }
    }
    return soonest;
}

}
