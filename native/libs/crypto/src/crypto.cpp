#include <lucent/crypto/crypto.hpp>

#include <cstddef>
#include <expected>
#include <span>

#include <monocypher-ed25519.h>
#include <monocypher.h>

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

}
