#pragma once

#include <array>
#include <chrono>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/session.hpp>

// The lease and its renewal (POST /v1/sessions/:id/lease: frames both ways, each behind the
// loader's own part). The module runs only while it holds a lease: it counts the duration on its
// monotonic clock from when it sent the request the lease answers, so neither a recorded lease nor
// the system clock extends one.

namespace lucent::wire {

inline constexpr usize challenge_nonce_size = 16;
inline constexpr usize signals_size = 64;
inline constexpr usize max_features = 4096;

// A range of the module's own image, relative to its base, to hash under the nonce; the answer
// rides the next renewal.
struct hash_challenge {
    std::array<std::byte, challenge_nonce_size> nonce{};
    u32 offset = 0;
    u32 size = 0;

    auto operator==(const hash_challenge&) const -> bool = default;
};

// kit::entitlements on the wire: everything, or the listed features (per-release keyed feature
// ids, sorted, unique, never 0). Everything lists none.
struct entitled_features {
    bool is_everything = false;
    std::vector<u64> features;

    auto operator==(const entitled_features&) const -> bool = default;
};

struct lease {
    session_id session;
    device_id device;
    release_id release;
    u64 sequence = 0;
    // The nonce of the hello or renewal this lease answers.
    module_nonce nonce{};
    std::chrono::milliseconds duration{};
    u64 bundle_revision = 0;
    hash_challenge challenge;
    // A product id, as ids.hpp describes it.
    std::string product;
    entitled_features entitled;
    crypto::signature signature{};

    auto operator==(const lease&) const -> bool = default;
};

struct lease_renewal {
    // The lease sequence asked for: the held lease's plus one.
    u64 sequence = 0;
    module_nonce nonce{};
    // The answer to the held lease's challenge.
    crypto::digest challenge_answer{};
    // Bits and small enums, assigned in slice 3; every value is canonical, so assigning them
    // needs no new version.
    std::array<std::byte, signals_size> signals{};

    auto operator==(const lease_renewal&) const -> bool = default;
};

// The bytes the signature covers: everything before it.
auto signed_bytes(const lease& granted) -> std::vector<std::byte>;

// Fills in the signature.
auto sign_lease(lease granted, const crypto::signing_key& lease_key) -> lease;

auto verify_lease(const lease& granted, const crypto::public_key& lease_key) -> result<void>;

auto encode_lease(const lease& granted) -> std::vector<std::byte>;

// Canonical or nothing: a non-zero duration and challenge size, a valid product id, features as
// described on entitled_features, nothing trailing. It doesn't verify the signature.
auto decode_lease(std::span<const std::byte> bytes) -> result<lease>;

auto encode_lease_renewal(const lease_renewal& renewal) -> std::vector<std::byte>;
auto decode_lease_renewal(std::span<const std::byte> bytes) -> result<lease_renewal>;

// The loader's own part of each lease exchange, outside the module's AEAD so the loader can read
// and write it: the server names a range of the module's image, the loader hashes it from outside
// the module's process, and its answer rides the next renewal. Disagreement with the module's own
// answer is a signal; neither ever changes what the client sees.

// The request body: the loader's answer to the last loader challenge it was given, if any (none
// before the first lease response), then the module's renewal frame.
struct lease_request {
    std::optional<crypto::digest> loader_answer;
    frame renewal;

    auto operator==(const lease_request&) const -> bool = default;
};

// The response body: the next loader challenge, then the server's frame with the lease.
struct lease_response {
    hash_challenge loader_challenge;
    frame lease;

    auto operator==(const lease_response&) const -> bool = default;
};

auto encode_lease_request(const lease_request& request) -> std::vector<std::byte>;

// Canonical or nothing: an answer flag of 0 or 1, a frame from module to server running to the end.
auto decode_lease_request(std::span<const std::byte> bytes) -> result<lease_request>;

auto encode_lease_response(const lease_response& response) -> std::vector<std::byte>;

// Canonical or nothing: a non-zero challenge size, a frame from server to module running to the
// end.
auto decode_lease_response(std::span<const std::byte> bytes) -> result<lease_response>;

}
