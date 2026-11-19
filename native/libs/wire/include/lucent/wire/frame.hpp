#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

// The session's frame: everything between module and server after the key exchange, sealed with
// XChaCha20-Poly1305 under the direction's session key. The loader relays frames and sees only
// their headers.
//
// A receiver accepts a frame only when its sequence is above the highest it has accepted in that
// direction: replays and reordering are refused, a lost frame costs nothing. The nonce is random
// rather than derived from the sequence, so a server that loses its counter (a restart, a second
// process) still never repeats one under a key.

namespace lucent::wire {

enum class direction : u8 {
    module_to_server = 1,
    server_to_module = 2,
};

// What the AEAD authenticates as associated data, in its wire encoding.
struct frame_header {
    session_id session;
    direction way = direction::module_to_server;
    u64 sequence = 0;

    auto operator==(const frame_header&) const -> bool = default;
};

inline constexpr usize max_frame_plain_size = usize{1} << 20U;

struct frame {
    frame_header header;
    crypto::aead_nonce nonce{};
    // The ciphertext, then the tag.
    std::vector<std::byte> sealed;

    auto operator==(const frame&) const -> bool = default;
};

// What seal_frame needs; the plaintext is borrowed for the call.
struct frame_contents {
    frame_header header;
    crypto::aead_nonce nonce{};
    std::span<const std::byte> plain;
};

auto associated_data(const frame_header& header) -> std::vector<std::byte>;

auto seal_frame(const crypto::secret_key& key, const frame_contents& contents) -> frame;

// Fails as malformed when the frame wasn't sealed under this key with exactly this header.
auto open_frame(const crypto::secret_key& key, const frame& sealed) -> result<crypto::secret_bytes>;

auto encode_frame(const frame& sealed) -> std::vector<std::byte>;

// Canonical or nothing: a known direction, a tag at least, a plaintext within the bound.
auto decode_frame(std::span<const std::byte> bytes) -> result<frame>;

}
