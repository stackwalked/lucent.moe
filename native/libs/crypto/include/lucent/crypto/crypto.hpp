#pragma once

#include <array>
#include <cstddef>
#include <span>

namespace lucent::crypto {

// Standard Ed25519 (RFC 8032, SHA-512) so the TS server's WebCrypto verifies what we sign, and
// BLAKE2b-256 for digests. Every use of cryptography goes through this header, so the library
// behind it can change in one place.

inline constexpr usize seed_size = 32;
inline constexpr usize public_key_size = 32;
inline constexpr usize signature_size = 64;
inline constexpr usize digest_size = 32;

using seed = std::array<std::byte, seed_size>;
using public_key = std::array<std::byte, public_key_size>;
using signature = std::array<std::byte, signature_size>;
using digest = std::array<std::byte, digest_size>;

// An Ed25519 signing key. Wiped when destroyed; never copied.
class signing_key final {
public:
    static auto from_seed(const seed& material) -> signing_key;

    signing_key(const signing_key&) = delete ("secret material has one copy");
    auto operator=(const signing_key&) -> signing_key& = delete ("secret material has one copy");
    signing_key(signing_key&& other) noexcept;
    auto operator=(signing_key&&) -> signing_key& = delete ("secret material has one copy");
    ~signing_key();

    auto public_part() const -> const public_key&;
    auto sign(std::span<const std::byte> message) const -> signature;

private:
    signing_key() = default;

    // Monocypher's layout: the seed, then the public key.
    std::array<std::byte, 64> m_secret{};
    public_key m_public{};
};

// Fails as malformed when the signature isn't the key's over exactly these bytes.
auto verify(const public_key& signer, std::span<const std::byte> message, const signature& seal)
    -> result<void>;

auto hash(std::span<const std::byte> message) -> digest;

}
