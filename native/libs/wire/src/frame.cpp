#include <lucent/wire/frame.hpp>

#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   context "lucent frame v1" (32), session id (16), u8 direction, u64 sequence,
//   nonce (24), ciphertext, tag (16).
// The associated data is everything before the nonce; the ciphertext runs to the tag.

namespace lucent::wire {
namespace {

constexpr u32 frame_version = 1;

auto is_known(direction way) -> bool {
    switch (way) {
    case direction::module_to_server:
    case direction::server_to_module:
        return true;
    }
    return false;
}

auto write_header(detail::writer& out, const frame_header& header) -> void {
    out.write_context("frame", frame_version);
    out.write_bytes(header.session.bytes);
    out.write_u8(std::to_underlying(header.way));
    out.write_u64(header.sequence);
}

}

auto associated_data(const frame_header& header) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_known(header.way));
    detail::writer out;
    write_header(out, header);
    return out.take();
}

auto seal_frame(const crypto::secret_key& key, const frame_contents& contents) -> frame {
    LUCENT_INVARIANT(contents.plain.size() <= max_frame_plain_size);
    return frame{
        .header = contents.header,
        .nonce = contents.nonce,
        .sealed =
            crypto::seal(key, contents.nonce, associated_data(contents.header), contents.plain),
    };
}

auto open_frame(const crypto::secret_key& key, const frame& sealed)
    -> result<crypto::secret_bytes> {
    return crypto::open(key, sealed.nonce, associated_data(sealed.header), sealed.sealed);
}

auto encode_frame(const frame& sealed) -> std::vector<std::byte> {
    LUCENT_INVARIANT(sealed.sealed.size() >= crypto::aead_tag_size);
    LUCENT_INVARIANT(sealed.sealed.size() - crypto::aead_tag_size <= max_frame_plain_size);
    detail::writer out;
    LUCENT_INVARIANT(is_known(sealed.header.way));
    write_header(out, sealed.header);
    out.write_bytes(sealed.nonce);
    out.write_bytes(sealed.sealed);
    return out.take();
}

auto decode_frame(std::span<const std::byte> bytes) -> result<frame> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("frame", frame_version));
    frame decoded;
    decoded.header.session.bytes = LUCENT_TRY(input.read_array<id_size>());
    decoded.header.way = static_cast<direction>(LUCENT_TRY(input.read_u8()));
    if (!is_known(decoded.header.way)) {
        return std::unexpected(detail::malformed);
    }
    decoded.header.sequence = LUCENT_TRY(input.read_u64());
    decoded.nonce = LUCENT_TRY(input.read_array<crypto::aead_nonce_size>());
    const usize sealed_size = input.remaining();
    if (sealed_size < crypto::aead_tag_size
        || sealed_size - crypto::aead_tag_size > max_frame_plain_size) {
        return std::unexpected(detail::malformed);
    }
    const std::span<const std::byte> sealed = LUCENT_TRY(input.read_bytes(sealed_size));
    decoded.sealed.assign(sealed.begin(), sealed.end());
    return detail::finish(input, std::move(decoded));
}

}
