#include <lucent/wire/refusal.hpp>

#include <chrono>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include "codec.hpp"

// Version 1 on the wire: context "lucent refusal v1" (32), u8 code, u8 has retry-after (0 or 1),
// and u32 retry-after in milliseconds after 1 only.
//
// From old lucent's codes: licenses became entitlements (ENTITLEMENT_INACTIVE); releases are
// promoted, not toggled, so a channel without a current release is RELEASE_UNAVAILABLE rather
// than RELEASE_DISABLED; the newest session takes a full slot and the old one learns it on its
// next renewal (SLOT_TAKEN, not SLOT_OCCUPIED); intents became starts (START_MISMATCH,
// START_EXPIRED); the client that must update is the loader (LOADER_UPDATE_REQUIRED).
// INTEGRITY_REFUSED is gone: integrity is never a reason a client sees.

namespace lucent::wire {
namespace {

constexpr u32 refusal_version = 1;

}

auto is_known(refusal_code code) -> bool {
    switch (code) {
    case refusal_code::auth_required:
    case refusal_code::proof_invalid:
    case refusal_code::entitlement_inactive:
    case refusal_code::device_revoked:
    case refusal_code::release_unavailable:
    case refusal_code::channel_not_allowed:
    case refusal_code::account_suspended:
    case refusal_code::not_found:
    case refusal_code::slot_taken:
    case refusal_code::stale_sequence:
    case refusal_code::idempotency_conflict:
    case refusal_code::already_enrolled:
    case refusal_code::key_in_use:
    case refusal_code::enrollment_limit:
    case refusal_code::start_mismatch:
    case refusal_code::session_ended:
    case refusal_code::start_expired:
    case refusal_code::invalid_request:
    case refusal_code::game_build_unsupported:
    case refusal_code::game_update_required:
    case refusal_code::loader_update_required:
    case refusal_code::rate_limited:
    case refusal_code::service_unavailable:
        return true;
    }
    return false;
}

namespace {

auto is_canonical(const refusal& refused) -> bool {
    return std::to_underlying(refused.code) != 0
           && (!refused.retry_after
               || (refused.retry_after->count() >= 0
                   && std::cmp_less_equal(refused.retry_after->count(), u32{0xffff'ffff})));
}

}

auto name_of(refusal_code code) -> std::optional<std::string_view> {
    switch (code) {
    case refusal_code::auth_required:
        return "AUTH_REQUIRED";
    case refusal_code::proof_invalid:
        return "PROOF_INVALID";
    case refusal_code::entitlement_inactive:
        return "ENTITLEMENT_INACTIVE";
    case refusal_code::device_revoked:
        return "DEVICE_REVOKED";
    case refusal_code::release_unavailable:
        return "RELEASE_UNAVAILABLE";
    case refusal_code::channel_not_allowed:
        return "CHANNEL_NOT_ALLOWED";
    case refusal_code::account_suspended:
        return "ACCOUNT_SUSPENDED";
    case refusal_code::not_found:
        return "NOT_FOUND";
    case refusal_code::slot_taken:
        return "SLOT_TAKEN";
    case refusal_code::stale_sequence:
        return "STALE_SEQUENCE";
    case refusal_code::idempotency_conflict:
        return "IDEMPOTENCY_CONFLICT";
    case refusal_code::already_enrolled:
        return "ALREADY_ENROLLED";
    case refusal_code::key_in_use:
        return "KEY_IN_USE";
    case refusal_code::enrollment_limit:
        return "ENROLLMENT_LIMIT";
    case refusal_code::start_mismatch:
        return "START_MISMATCH";
    case refusal_code::session_ended:
        return "SESSION_ENDED";
    case refusal_code::start_expired:
        return "START_EXPIRED";
    case refusal_code::invalid_request:
        return "INVALID_REQUEST";
    case refusal_code::game_build_unsupported:
        return "GAME_BUILD_UNSUPPORTED";
    case refusal_code::game_update_required:
        return "GAME_UPDATE_REQUIRED";
    case refusal_code::loader_update_required:
        return "LOADER_UPDATE_REQUIRED";
    case refusal_code::rate_limited:
        return "RATE_LIMITED";
    case refusal_code::service_unavailable:
        return "SERVICE_UNAVAILABLE";
    }
    return std::nullopt;
}

auto encode_refusal(const refusal& refused) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(refused));
    detail::writer out;
    out.write_context("refusal", refusal_version);
    out.write_u8(std::to_underlying(refused.code));
    out.write_u8(refused.retry_after ? 1 : 0);
    if (refused.retry_after) {
        out.write_u32(static_cast<u32>(refused.retry_after->count()));
    }
    return out.take();
}

auto decode_refusal(std::span<const std::byte> bytes) -> result<refusal> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("refusal", refusal_version));
    refusal refused;
    refused.code = static_cast<refusal_code>(LUCENT_TRY(input.read_u8()));
    if (std::to_underlying(refused.code) == 0) {
        return std::unexpected(detail::malformed);
    }
    if (LUCENT_TRY(input.read_bool())) {
        refused.retry_after = std::chrono::milliseconds{LUCENT_TRY(input.read_u32())};
    }
    return detail::finish(input, refused);
}

}
