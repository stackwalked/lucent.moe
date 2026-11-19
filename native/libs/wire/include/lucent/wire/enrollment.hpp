#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/wire/ids.hpp>

// POST /v1/enrollments and the loader's polls of it. The candidate device key is the DPoP key, so
// the proof and the public key travel in the DPoP header, not here; the member approves in the
// browser against a match code both sides derive from the key's thumbprint.

namespace lucent::wire {

// Where the device key lives. Software keys are recorded for risk scoring and staff to see.
enum class key_storage : u8 {
    tpm = 0,
    software = 1,
};

struct enrollment_request {
    key_storage storage = key_storage::tpm;

    auto operator==(const enrollment_request&) const -> bool = default;
};

enum class enrollment_state : u8 {
    pending = 0,
    approved = 1,
    denied = 2,
    expired = 3,
};

struct enrollment_status {
    enrollment_id enrollment;
    enrollment_state state = enrollment_state::pending;
    // Present exactly when approved.
    std::optional<device_id> device;

    auto operator==(const enrollment_status&) const -> bool = default;
};

auto encode_enrollment_request(const enrollment_request& request) -> std::vector<std::byte>;
auto decode_enrollment_request(std::span<const std::byte> bytes) -> result<enrollment_request>;

auto encode_enrollment_status(const enrollment_status& status) -> std::vector<std::byte>;

// Canonical or nothing: a known state, a device id after approved and nowhere else.
auto decode_enrollment_status(std::span<const std::byte> bytes) -> result<enrollment_status>;

}
