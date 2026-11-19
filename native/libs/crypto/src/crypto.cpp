#include <lucent/crypto/crypto.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <vector>

#include <monocypher-ed25519.h>
#include <monocypher.h>

#include <lucent/core/narrow.hpp>

namespace lucent::crypto {
namespace {

// Monocypher speaks uint8_t; our bytes are std::byte. Same object representation.
auto as_u8(std::span<const std::byte> bytes) -> const u8* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and u8 share one object representation; Monocypher takes u8.
    return reinterpret_cast<const u8*>(bytes.data());
}

auto writable_u8(std::span<std::byte> bytes) -> u8* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): as above.
    return reinterpret_cast<u8*>(bytes.data());
}

using encoding = std::array<u8, 32>;

// Little-endian: 2^255 - 19, the field's prime p, and L, the prime order of the base point.
constexpr encoding field_prime{
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
constexpr encoding group_order{
    0xed,
    0xd3,
    0xf5,
    0x5c,
    0x1a,
    0x63,
    0x12,
    0x58,
    0xd6,
    0x9c,
    0xf7,
    0xa2,
    0xde,
    0xf9,
    0xde,
    0x14,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x10,
};

// The y coordinates (sign bit cleared) of the eight points of small order, in every encoding a
// lax decoder accepts: 0 (the two points of order 4), 1 (the identity), the two y of the four
// points of order 8, p - 1 (the point of order 2), and p and p + 1, which reduce to 0 and 1.
// found: libsodium's ge25519_has_small_order (crypto_core/ed25519/ref10/ed25519_ref10.c), the same
// list; contracts/ed25519/v1/strict.json has a case for each kind.
// breaks: a small-order key or R verifies a signature over any message, or over many.
constexpr std::array<encoding, 7> small_order_y{
    encoding{},
    encoding{0x01},
    encoding{
        0x26,
        0xe8,
        0x95,
        0x8f,
        0xc2,
        0xb2,
        0x27,
        0xb0,
        0x45,
        0xc3,
        0xf4,
        0x89,
        0xf2,
        0xef,
        0x98,
        0xf0,
        0xd5,
        0xdf,
        0xac,
        0x05,
        0xd3,
        0xc6,
        0x33,
        0x39,
        0xb1,
        0x38,
        0x02,
        0x88,
        0x6d,
        0x53,
        0xfc,
        0x05,
    },
    encoding{
        0xc7,
        0x17,
        0x6a,
        0x70,
        0x3d,
        0x4d,
        0xd8,
        0x4f,
        0xba,
        0x3c,
        0x0b,
        0x76,
        0x0d,
        0x10,
        0x67,
        0x0f,
        0x2a,
        0x20,
        0x53,
        0xfa,
        0x2c,
        0x39,
        0xcc,
        0xc6,
        0x4e,
        0xc7,
        0xfd,
        0x77,
        0x92,
        0xac,
        0x03,
        0x7a,
    },
    encoding{
        0xec,
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
    },
    field_prime,
    encoding{
        0xee,
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
    },
};

auto to_encoding(std::span<const std::byte, 32> bytes) -> encoding {
    encoding out{};
    std::ranges::transform(bytes, out.begin(), [](std::byte each) {
        return static_cast<u8>(each);
    });
    return out;
}

// Little-endian comparison of two 256-bit numbers.
auto is_below(const encoding& value, const encoding& bound) -> bool {
    for (usize index = value.size(); index-- > 0;) {
        if (value.at(index) != bound.at(index)) {
            return value.at(index) < bound.at(index);
        }
    }
    return false;
}

auto without_sign(encoding point) -> encoding {
    point.back() &= 0x7fU;
    return point;
}

// One encoding per point: y below p, and the sign bit clear where x is 0 (y = 1 and y = p - 1),
// where "negative zero" would name the same point again.
auto is_canonical_point(const encoding& point) -> bool {
    const encoding y = without_sign(point);
    const bool has_sign = (point.back() & 0x80U) != 0;
    const bool is_x_zero = y == small_order_y.at(1) || y == small_order_y.at(4);
    return is_below(y, field_prime) && !(has_sign && is_x_zero);
}

auto is_small_order(const encoding& point) -> bool {
    return std::ranges::contains(small_order_y, without_sign(point));
}

// What Monocypher's crypto_ed25519_check doesn't refuse on its own: monocypher.c 4.0.2's
// crypto_eddsa_check_equation allows non-canonical A and R ("*Allow* non-cannonical encoding") and
// checks the cofactored equation, so small-order A and R pass it. The decided rule is strict
// verification on both sides (wishlist.md, native contracts), with the TS server's twin of this
// check in platform/packages/wire.
auto is_strict(const public_key& signer, const signature& seal) -> bool {
    const encoding key = to_encoding(signer);
    const encoding nonce_point = to_encoding(std::span{seal}.first<32>());
    const encoding response = to_encoding(std::span{seal}.last<32>());
    return is_below(response, group_order)
           && is_canonical_point(key)
           && is_canonical_point(nonce_point)
           && !is_small_order(key)
           && !is_small_order(nonce_point);
}

}

auto signing_key::from_seed(const seed& material) -> signing_key {
    signing_key key;
    // crypto_ed25519_key_pair wipes the seed it's given, so it gets a copy.
    seed scratch = material;
    crypto_ed25519_key_pair(
        writable_u8(key.m_secret), writable_u8(key.m_public), writable_u8(scratch)
    );
    return key;
}

signing_key::signing_key(signing_key&& other) noexcept
    : m_secret{other.m_secret}
    , m_public{other.m_public} {
    crypto_wipe(writable_u8(other.m_secret), other.m_secret.size());
}

signing_key::~signing_key() {
    crypto_wipe(writable_u8(m_secret), m_secret.size());
}

auto signing_key::public_part() const -> const public_key& {
    return m_public;
}

auto signing_key::sign(std::span<const std::byte> message) const -> signature {
    signature seal{};
    crypto_ed25519_sign(writable_u8(seal), as_u8(m_secret), as_u8(message), message.size());
    return seal;
}

auto verify(const public_key& signer, std::span<const std::byte> message, const signature& seal)
    -> result<void> {
    if (!is_strict(signer, seal)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (crypto_ed25519_check(as_u8(seal), as_u8(signer), as_u8(message), message.size()) != 0) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    return {};
}

auto hash(std::span<const std::byte> message) -> digest {
    digest out{};
    crypto_blake2b(writable_u8(out), out.size(), as_u8(message), message.size());
    return out;
}

auto keyed_hash(std::span<const std::byte, 32> key, std::span<const std::byte> message) -> digest {
    digest out{};
    crypto_blake2b_keyed(
        writable_u8(out), out.size(), as_u8(key), key.size(), as_u8(message), message.size()
    );
    return out;
}

auto wipe(std::span<std::byte> bytes) -> void {
    crypto_wipe(writable_u8(bytes), bytes.size());
}

auto secret_key::from_bytes(std::span<const std::byte, secret_key_size> material) -> secret_key {
    secret_key key;
    std::ranges::copy(material, key.m_bytes.begin());
    return key;
}

secret_key::secret_key(secret_key&& other) noexcept
    : m_bytes{other.m_bytes} {
    wipe(other.m_bytes);
}

secret_key::~secret_key() {
    wipe(m_bytes);
}

auto secret_key::as_bytes() const -> std::span<const std::byte, secret_key_size> {
    return m_bytes;
}

auto exchange_key::from_seed(const seed& material) -> exchange_key {
    exchange_key key;
    key.m_secret = material;
    crypto_x25519_public_key(writable_u8(key.m_public), as_u8(key.m_secret));
    return key;
}

exchange_key::exchange_key(exchange_key&& other) noexcept
    : m_secret{other.m_secret}
    , m_public{other.m_public} {
    wipe(other.m_secret);
}

exchange_key::~exchange_key() {
    wipe(m_secret);
}

auto exchange_key::public_part() const -> const exchange_public_key& {
    return m_public;
}

auto exchange_key::shared_secret(const exchange_public_key& peer) const -> result<secret_key> {
    std::array<std::byte, secret_key_size> shared{};
    crypto_x25519(writable_u8(shared), as_u8(m_secret), as_u8(peer));
    // A low-order peer key gives all zeros whatever our half is: the exchange would then bind
    // nothing of ours, so it is refused (RFC 7748, section 6.1).
    const std::array<std::byte, secret_key_size> zero{};
    const bool is_low_order = crypto_verify32(as_u8(shared), as_u8(zero)) == 0;
    if (is_low_order) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    secret_key out = secret_key::from_bytes(shared);
    wipe(shared);
    return out;
}

auto secret_bytes::zeroed(usize size) -> secret_bytes {
    return secret_bytes{size};
}

secret_bytes::secret_bytes(usize size)
    : m_bytes(size) {}

secret_bytes::~secret_bytes() {
    wipe(m_bytes);
}

auto secret_bytes::as_bytes() const -> std::span<const std::byte> {
    return m_bytes;
}

auto secret_bytes::as_writable_bytes() -> std::span<std::byte> {
    return m_bytes;
}

auto seal(
    const secret_key& key,
    const aead_nonce& nonce,
    std::span<const std::byte> associated,
    std::span<const std::byte> plain
) -> std::vector<std::byte> {
    std::vector<std::byte> sealed(plain.size() + aead_tag_size);
    const std::span<std::byte> cipher = std::span{sealed}.first(plain.size());
    const std::span<std::byte> tag = std::span{sealed}.subspan(plain.size());
    crypto_aead_lock(
        writable_u8(cipher),
        writable_u8(tag),
        as_u8(key.as_bytes()),
        as_u8(nonce),
        as_u8(associated),
        associated.size(),
        as_u8(plain),
        plain.size()
    );
    return sealed;
}

auto open(
    const secret_key& key,
    const aead_nonce& nonce,
    std::span<const std::byte> associated,
    std::span<const std::byte> sealed
) -> result<secret_bytes> {
    if (sealed.size() < aead_tag_size) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    const usize text_size = sealed.size() - aead_tag_size;
    secret_bytes plain = secret_bytes::zeroed(text_size);
    const i32 status = crypto_aead_unlock(
        writable_u8(plain.as_writable_bytes()),
        as_u8(sealed.subspan(text_size)),
        as_u8(key.as_bytes()),
        as_u8(nonce),
        as_u8(associated),
        associated.size(),
        as_u8(sealed.first(text_size)),
        text_size
    );
    if (status != 0) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    return plain;
}

auto argon2id(const argon2id_inputs& inputs, argon2id_cost cost) -> result<secret_key> {
    LUCENT_INVARIANT(cost.lanes >= 1 && cost.passes >= 1 && cost.blocks >= 8 * cost.lanes);
    if (cost.blocks > max_argon2id_blocks) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    constexpr usize block_size = 1024;
    std::vector<std::byte> work_area(usize{cost.blocks} * block_size);
    std::array<std::byte, secret_key_size> derived{};
    crypto_argon2(
        writable_u8(derived),
        narrow<u32>(derived.size()),
        work_area.data(),
        crypto_argon2_config{
            .algorithm = CRYPTO_ARGON2_ID,
            .nb_blocks = cost.blocks,
            .nb_passes = cost.passes,
            .nb_lanes = cost.lanes,
        },
        crypto_argon2_inputs{
            .pass = as_u8(inputs.passphrase),
            .salt = as_u8(inputs.salt),
            .pass_size = narrow<u32>(inputs.passphrase.size()),
            .salt_size = narrow<u32>(inputs.salt.size()),
        },
        crypto_argon2_extras{
            .key = inputs.secret.empty() ? nullptr : as_u8(inputs.secret),
            .ad = inputs.associated.empty() ? nullptr : as_u8(inputs.associated),
            .key_size = narrow<u32>(inputs.secret.size()),
            .ad_size = narrow<u32>(inputs.associated.size()),
        }
    );
    wipe(work_area);
    secret_key out = secret_key::from_bytes(derived);
    wipe(derived);
    return out;
}

}
