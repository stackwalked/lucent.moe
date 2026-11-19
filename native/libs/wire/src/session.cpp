#include <lucent/wire/session.hpp>

#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   hello: context "lucent session hello v1" (32), module X25519 key (32), module nonce (16),
//     release id (16), u32 boot_info version, u8 image kind, u64 image base, u32 image size.
//   exchange: context "lucent session exchange v1" (32), session id (16), module X25519 key (32),
//     module nonce (16), server X25519 key (32), Ed25519 signature (64) over everything before it.
//   reply: the exchange, then a frame running to the end.
//
// Keys derive from one unkeyed BLAKE2b-256 per direction over fixed-size fields after a fixed
// context, so no two inputs share an encoding. Unkeyed because Bun has BLAKE2b-256 built in but
// not its keyed mode, and the server derives the same keys. Both public halves go in, as in
// libsodium's crypto_kx, so the keys commit to the whole exchange and not only its secret.

namespace lucent::wire {
namespace {

constexpr u32 hello_version = 1;
constexpr u32 exchange_version = 1;
constexpr u32 keys_version = 1;

// 2^255 - 19, little-endian: an X25519 key is canonical below it.
constexpr std::array<u8, 32> field_prime{
    0xed,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0x7f,
};

// RFC 7748 lets a decoder mask the top bit and reduce mod p, so 2^255 - 19 and above alias
// smaller keys; only the reduced encoding is canonical.
auto is_canonical(const crypto::exchange_public_key& key) -> bool {
    for (usize index = key.size(); index-- > 0;) {
        const u8 digit = static_cast<u8>(key.at(index));
        if (digit != field_prime.at(index)) {
            return digit < field_prime.at(index);
        }
    }
    return false;
}

auto is_known(image_kind kind) -> bool {
    switch (kind) {
    case image_kind::loaded:
    case image_kind::mapped:
        return true;
    }
    return false;
}

auto read_exchange_key(detail::reader& input) -> result<crypto::exchange_public_key> {
    const crypto::exchange_public_key key =
        LUCENT_TRY(input.read_array<crypto::exchange_public_key_size>());
    if (!is_canonical(key)) {
        return std::unexpected(detail::malformed);
    }
    return key;
}

auto write_exchange_fields(detail::writer& out, const session_exchange& exchange) -> void {
    LUCENT_INVARIANT(is_canonical(exchange.module_key) && is_canonical(exchange.server_key));
    out.write_context("session exchange", exchange_version);
    out.write_bytes(exchange.session.bytes);
    out.write_bytes(exchange.module_key);
    out.write_bytes(exchange.nonce);
    out.write_bytes(exchange.server_key);
}

auto read_exchange(detail::reader& input) -> result<session_exchange> {
    LUCENT_TRY(input.read_context("session exchange", exchange_version));
    session_exchange exchange;
    exchange.session.bytes = LUCENT_TRY(input.read_array<id_size>());
    exchange.module_key = LUCENT_TRY(read_exchange_key(input));
    exchange.nonce = LUCENT_TRY(input.read_array<module_nonce_size>());
    exchange.server_key = LUCENT_TRY(read_exchange_key(input));
    exchange.signature = LUCENT_TRY(input.read_array<crypto::signature_size>());
    return exchange;
}

auto derive_key(direction way, const crypto::secret_key& shared, const exchange_halves& halves)
    -> crypto::secret_key {
    detail::writer input;
    input.write_context("session keys", keys_version);
    input.write_u8(std::to_underlying(way));
    input.write_bytes(shared.as_bytes());
    input.write_bytes(halves.module_key);
    input.write_bytes(halves.server_key);
    std::vector<std::byte> material = input.take();
    crypto::digest derived = crypto::hash(material);
    crypto::secret_key key = crypto::secret_key::from_bytes(derived);
    crypto::wipe(material);
    crypto::wipe(derived);
    return key;
}

}

auto encode_session_hello(const session_hello& hello) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(hello.module_key));
    LUCENT_INVARIANT(is_known(hello.boot.kind));
    detail::writer out;
    out.write_context("session hello", hello_version);
    out.write_bytes(hello.module_key);
    out.write_bytes(hello.nonce);
    out.write_bytes(hello.release.bytes);
    out.write_u32(hello.boot.boot_info_version);
    out.write_u8(std::to_underlying(hello.boot.kind));
    out.write_u64(hello.boot.image_base);
    out.write_u32(hello.boot.image_size);
    return out.take();
}

auto decode_session_hello(std::span<const std::byte> bytes) -> result<session_hello> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("session hello", hello_version));
    session_hello hello;
    hello.module_key = LUCENT_TRY(read_exchange_key(input));
    hello.nonce = LUCENT_TRY(input.read_array<module_nonce_size>());
    hello.release.bytes = LUCENT_TRY(input.read_array<id_size>());
    hello.boot.boot_info_version = LUCENT_TRY(input.read_u32());
    hello.boot.kind = static_cast<image_kind>(LUCENT_TRY(input.read_u8()));
    if (!is_known(hello.boot.kind)) {
        return std::unexpected(detail::malformed);
    }
    hello.boot.image_base = LUCENT_TRY(input.read_u64());
    hello.boot.image_size = LUCENT_TRY(input.read_u32());
    return detail::finish(input, hello);
}

auto signed_bytes(const session_exchange& exchange) -> std::vector<std::byte> {
    detail::writer out;
    write_exchange_fields(out, exchange);
    return out.take();
}

auto sign_session_exchange(session_exchange exchange, const crypto::signing_key& lease_key)
    -> session_exchange {
    exchange.signature = lease_key.sign(signed_bytes(exchange));
    return exchange;
}

auto verify_session_exchange(const session_exchange& exchange, const crypto::public_key& lease_key)
    -> result<void> {
    return crypto::verify(lease_key, signed_bytes(exchange), exchange.signature);
}

auto encode_session_exchange(const session_exchange& exchange) -> std::vector<std::byte> {
    detail::writer out;
    write_exchange_fields(out, exchange);
    out.write_bytes(exchange.signature);
    return out.take();
}

auto decode_session_exchange(std::span<const std::byte> bytes) -> result<session_exchange> {
    detail::reader input{bytes};
    const session_exchange exchange = LUCENT_TRY(read_exchange(input));
    return detail::finish(input, exchange);
}

auto encode_session_reply(const session_reply& reply) -> std::vector<std::byte> {
    LUCENT_INVARIANT(reply.first_lease.header.way == direction::server_to_module);
    LUCENT_INVARIANT(reply.first_lease.header.session == reply.exchange.session);
    std::vector<std::byte> out = encode_session_exchange(reply.exchange);
    out.append_range(encode_frame(reply.first_lease));
    return out;
}

auto decode_session_reply(std::span<const std::byte> bytes) -> result<session_reply> {
    detail::reader input{bytes};
    const session_exchange exchange = LUCENT_TRY(read_exchange(input));
    const std::span<const std::byte> rest = LUCENT_TRY(input.read_bytes(input.remaining()));
    frame first_lease = LUCENT_TRY(decode_frame(rest));
    if (first_lease.header.way != direction::server_to_module
        || first_lease.header.session != exchange.session) {
        return std::unexpected(detail::malformed);
    }
    return session_reply{.exchange = exchange, .first_lease = std::move(first_lease)};
}

auto derive_session_keys(const crypto::secret_key& shared, const exchange_halves& halves)
    -> session_keys {
    return session_keys{
        .module_to_server = derive_key(direction::module_to_server, shared, halves),
        .server_to_module = derive_key(direction::server_to_module, shared, halves),
    };
}

}
