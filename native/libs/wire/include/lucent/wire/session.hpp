#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>

// How a module opens its session (POST /v1/starts/:id/session, relayed opaquely by the loader):
// its hello, then the server's signed half of the key exchange and the first lease in a frame.

namespace lucent::wire {

inline constexpr usize module_nonce_size = 16;

// Fresh from the module's CSPRNG for every hello and renewal; the lease that answers it signs it
// back, so a recorded lease never answers a later request.
using module_nonce = std::array<std::byte, module_nonce_size>;

// How the module's image got into its process: kit::image_kind's values.
enum class image_kind : u8 {
    loaded = 0,
    mapped = 1,
};

// What the module reports of its own boot, once. The base lets the server relocate its own copy
// of the image to check hash-challenge answers; the module keeps no relocation data.
struct boot_report {
    u32 boot_info_version = 0;
    image_kind kind = image_kind::loaded;
    u64 image_base = 0;
    u32 image_size = 0;

    auto operator==(const boot_report&) const -> bool = default;
};

struct session_hello {
    crypto::exchange_public_key module_key{};
    module_nonce nonce{};
    release_id release;
    boot_report boot;

    auto operator==(const session_hello&) const -> bool = default;
};

// The server's half, signed by the lease key whose public part is in the signed image. Echoing
// the module's key and nonce binds the answer to this boot's hello.
struct session_exchange {
    session_id session;
    crypto::exchange_public_key module_key{};
    module_nonce nonce{};
    crypto::exchange_public_key server_key{};
    crypto::signature signature{};

    auto operator==(const session_exchange&) const -> bool = default;
};

// The response body: the exchange, then the first lease sealed under the keys it sets up
// (server to module, sequence 0).
struct session_reply {
    session_exchange exchange;
    frame first_lease;

    auto operator==(const session_reply&) const -> bool = default;
};

// One key per direction, so neither side's frames can be reflected back at it.
struct session_keys {
    crypto::secret_key module_to_server;
    crypto::secret_key server_to_module;
};

auto encode_session_hello(const session_hello& hello) -> std::vector<std::byte>;

// Canonical or nothing: a known image kind, an X25519 key below 2^255 - 19, nothing trailing.
auto decode_session_hello(std::span<const std::byte> bytes) -> result<session_hello>;

// The bytes the signature covers: everything before it.
auto signed_bytes(const session_exchange& exchange) -> std::vector<std::byte>;

// Fills in the signature.
auto sign_session_exchange(session_exchange exchange, const crypto::signing_key& lease_key)
    -> session_exchange;

auto verify_session_exchange(const session_exchange& exchange, const crypto::public_key& lease_key)
    -> result<void>;

auto encode_session_exchange(const session_exchange& exchange) -> std::vector<std::byte>;
auto decode_session_exchange(std::span<const std::byte> bytes) -> result<session_exchange>;

auto encode_session_reply(const session_reply& reply) -> std::vector<std::byte>;
auto decode_session_reply(std::span<const std::byte> bytes) -> result<session_reply>;

// The two public halves of one exchange, named so they can't be swapped.
struct exchange_halves {
    crypto::exchange_public_key module_key{};
    crypto::exchange_public_key server_key{};
};

// Both directions' keys from the X25519 secret and the two public halves:
// BLAKE2b-256(context "lucent session keys v1" || direction || shared || module key || server key),
// the direction byte being frame's.
auto derive_session_keys(const crypto::secret_key& shared, const exchange_halves& halves)
    -> session_keys;

}
