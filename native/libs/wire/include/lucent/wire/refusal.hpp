#pragma once

#include <chrono>
#include <cstddef>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

// Why the server refused a /v1 request: the body of every 4xx and of a 503. The loader shows the
// reason and, when the module is running, unloads it. Integrity is never a reason.

namespace lucent::wire {

// Open to growth: a code this build doesn't know still decodes, keeping its number, so adding one
// needs no new refusal version; the loader shows an unknown code as a generic refusal.
// Stable: a code's number and name never change or get reused, and none names a capability or
// any other per-release detail, so the release host can show them from a user-facing catalog.
// 0 is no code, so zeroed memory never reads as one.
enum class refusal_code : u8 {
    auth_required = 1,
    proof_invalid = 2,
    entitlement_inactive = 3,
    device_revoked = 4,
    release_unavailable = 5,
    channel_not_allowed = 6,
    account_suspended = 7,
    not_found = 8,
    slot_taken = 9,
    stale_sequence = 10,
    idempotency_conflict = 11,
    already_enrolled = 12,
    key_in_use = 13,
    enrollment_limit = 14,
    start_mismatch = 15,
    session_ended = 16,
    start_expired = 17,
    invalid_request = 18,
    game_build_unsupported = 19,
    game_update_required = 20,
    loader_update_required = 21,
    rate_limited = 22,
    service_unavailable = 23,
};

// Whether this build has a name for the code.
auto is_known(refusal_code code) -> bool;

// The code's SCREAMING_SNAKE name, as the platform spells it; nothing for a code this build
// doesn't know.
auto name_of(refusal_code code) -> std::optional<std::string_view>;

struct refusal {
    // Possibly one this build doesn't know: is_known says.
    refusal_code code = refusal_code::service_unavailable;
    std::optional<std::chrono::milliseconds> retry_after;

    auto operator==(const refusal&) const -> bool = default;
};

auto encode_refusal(const refusal& refused) -> std::vector<std::byte>;

// Canonical or nothing: a code other than 0 (an unknown one keeps its number), a retry-after flag
// of 0 or 1 with the value only after 1.
auto decode_refusal(std::span<const std::byte> bytes) -> result<refusal>;

}
