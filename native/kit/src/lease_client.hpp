#pragma once

#include <chrono>
#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/session.hpp>

#include "random.hpp"

namespace lucent::kit::detail {

// protection.md "Running": renewals every 15 s; a lease that lapses stops every feature and is
// resumed by any renewal within 5 minutes, after which the module unloads. The lease's own
// duration comes from the server.
inline constexpr std::chrono::seconds renewal_interval{15};
inline constexpr std::chrono::minutes resume_window{5};

// A renewal that never comes back is retried by the next one; this many unanswered renewals for
// one lease are remembered, which covers the resume window at the renewal interval.
inline constexpr isize max_pending_renewals = 32;

// What the module says of itself in its hello, and the key its leases must be signed by.
struct lease_identity {
    crypto::public_key lease_key{};
    wire::release_id release;
    wire::boot_report boot;
};

enum class lease_standing : u8 {
    // Inside the held lease's duration: features may run.
    held,
    // Past it, inside the resume window: features are stopped, renewals go on.
    lapsed,
    // Past the resume window: the session is over.
    ended,
};

// The module's half of its session with the server, relayed by the host: the hello, the key
// exchange it answers, and every lease after. Holds the session keys until it is destroyed, which
// is when the module unloads.
//
// Every lease is measured from when the module sent the request it answers, on the module's own
// monotonic clock, so neither a delayed relay nor the system clock lengthens one.
//
// One thread at a time: the lifecycle thread opens it, then a kit worker owns it.
class lease_client final {
public:
    // A fresh exchange key and nonce for this boot.
    static auto create(const lease_identity& identity, random_source& random)
        -> result<lease_client>;

    lease_client(const lease_client&) = delete ("holds the session's secret keys");
    auto operator=(const lease_client&) -> lease_client& = delete ("holds secret keys");
    lease_client(lease_client&&) noexcept = default;
    auto operator=(lease_client&&) -> lease_client& = delete ("holds secret keys");
    ~lease_client() = default;

    // POST /v1/starts/:id/session's body.
    auto hello() const -> std::vector<std::byte>;

    // The server's reply to the hello sent at `sent`: its signed half of the exchange and the
    // first lease. Malformed unless the exchange is signed by the lease key over this hello's key
    // and nonce, and the lease answers this hello for this release. Once only.
    auto open(std::span<const std::byte> reply, clock::time_point sent) -> result<entitlements>;

    // The next renewal's frame, to send now; nothing until open() succeeded.
    auto renewal(clock::time_point now, random_source& random) -> result<std::vector<std::byte>>;

    // A lease frame the host relayed back. Malformed or stale unless it is the server's, newer than
    // any accepted, and the next lease of this session answering a renewal still remembered. A
    // refused frame changes nothing.
    auto accept(std::span<const std::byte> frame) -> result<entitlements>;

    auto standing(clock::time_point now) const -> lease_standing;
    auto is_renewal_due(clock::time_point now) const -> bool;

    // The soonest of the next renewal, the lapse and the end: when standing or is_renewal_due may
    // next change on their own.
    auto next_change(clock::time_point now) const -> clock::time_point;

private:
    struct pending_renewal {
        wire::module_nonce nonce{};
        clock::time_point sent;
    };

    struct session_state {
        wire::session_keys keys;
        wire::lease held;
        clock::time_point expires;
        // The highest frame sequence accepted from the server, and the last one sent to it.
        u64 highest_in = 0;
        u64 last_out = 0;
        clock::time_point last_renewal;
        std::vector<pending_renewal> pending;
    };

    lease_client(lease_identity identity, crypto::exchange_key key, wire::module_nonce nonce);

    lease_identity m_identity;
    crypto::exchange_key m_key;
    wire::module_nonce m_hello_nonce{};
    std::optional<session_state> m_session;
};

// The lease's grant in the registry's terms.
auto entitlements_of(const wire::entitled_features& granted) -> entitlements;

}
