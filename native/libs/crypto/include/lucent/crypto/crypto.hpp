#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <vector>

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

// BLAKE2b-256 in its own keyed mode (RFC 7693), so a message is never copied behind its key.
auto keyed_hash(std::span<const std::byte, 32> key, std::span<const std::byte> message) -> digest;

// The module's session channel: X25519 (RFC 7748) for the key exchange and XChaCha20-Poly1305
// (Monocypher's crypto_aead_lock, the same construction as libsodium's
// crypto_aead_xchacha20poly1305_ietf) for its frames.

inline constexpr usize secret_key_size = 32;
inline constexpr usize exchange_public_key_size = 32;
inline constexpr usize aead_nonce_size = 24;
inline constexpr usize aead_tag_size = 16;

using exchange_public_key = std::array<std::byte, exchange_public_key_size>;
using aead_nonce = std::array<std::byte, aead_nonce_size>;

// Overwrites the bytes in a way the optimizer keeps.
auto wipe(std::span<std::byte> bytes) -> void;

// 32 secret bytes: a shared secret or a symmetric key. Wiped when destroyed; never copied.
class secret_key final {
public:
    static auto from_bytes(std::span<const std::byte, secret_key_size> material) -> secret_key;

    secret_key(const secret_key&) = delete ("secret material has one copy");
    auto operator=(const secret_key&) -> secret_key& = delete ("secret material has one copy");
    secret_key(secret_key&& other) noexcept;
    auto operator=(secret_key&&) -> secret_key& = delete ("secret material has one copy");
    ~secret_key();

    auto as_bytes() const -> std::span<const std::byte, secret_key_size>;

private:
    secret_key() = default;

    std::array<std::byte, secret_key_size> m_bytes{};
};

// One side of an X25519 key exchange. Wiped when destroyed; never copied.
class exchange_key final {
public:
    // The seed is the secret scalar as RFC 7748 takes it (clamped on use); it must come from a
    // CSPRNG.
    static auto from_seed(const seed& material) -> exchange_key;

    exchange_key(const exchange_key&) = delete ("secret material has one copy");
    auto operator=(const exchange_key&) -> exchange_key& = delete ("secret material has one copy");
    exchange_key(exchange_key&& other) noexcept;
    auto operator=(exchange_key&&) -> exchange_key& = delete ("secret material has one copy");
    ~exchange_key();

    auto public_part() const -> const exchange_public_key&;

    // Fails as malformed when the peer's key is of low order, which makes the secret all zero
    // whatever our half is.
    auto shared_secret(const exchange_public_key& peer) const -> result<secret_key>;

private:
    exchange_key() = default;

    std::array<std::byte, 32> m_secret{};
    exchange_public_key m_public{};
};

// Secret bytes of any length, such as an opened plaintext. Wiped when destroyed; never copied.
class secret_bytes final {
public:
    static auto zeroed(usize size) -> secret_bytes;

    secret_bytes(const secret_bytes&) = delete ("secret material has one copy");
    auto operator=(const secret_bytes&) -> secret_bytes& = delete ("secret material has one copy");
    secret_bytes(secret_bytes&& other) noexcept = default;
    auto operator=(secret_bytes&&) -> secret_bytes& = delete ("secret material has one copy");
    ~secret_bytes();

    auto as_bytes() const -> std::span<const std::byte>;
    auto as_writable_bytes() -> std::span<std::byte>;

private:
    explicit secret_bytes(usize size);

    // A moved-from vector is left empty, so only the live copy is wiped.
    std::vector<std::byte> m_bytes;
};

// The ciphertext, then the 16-byte tag. A nonce must never repeat under one key.
auto seal(
    const secret_key& key,
    const aead_nonce& nonce,
    std::span<const std::byte> associated,
    std::span<const std::byte> plain
) -> std::vector<std::byte>;

// Fails as malformed when the tag doesn't authenticate these exact bytes, associated data
// included; nothing of the plaintext is returned then.
auto open(
    const secret_key& key,
    const aead_nonce& nonce,
    std::span<const std::byte> associated,
    std::span<const std::byte> sealed
) -> result<secret_bytes>;

// Argon2id (RFC 9106), for keys derived from a passphrase. Monocypher runs every lane on the
// calling thread, so lanes add no speed, only compatibility with other implementations.
struct argon2id_cost {
    // 1 KiB blocks of memory; at least 8 per lane.
    u32 blocks = 0;
    u32 passes = 0;
    u32 lanes = 0;

    auto operator==(const argon2id_cost&) const -> bool = default;
};

struct argon2id_inputs {
    std::span<const std::byte> passphrase;
    std::span<const std::byte> salt;
    // RFC 9106's optional secret and associated data; empty for none.
    std::span<const std::byte> secret;
    std::span<const std::byte> associated;
};

// 4 GiB: more is refused as unsupported rather than allocated.
inline constexpr u32 max_argon2id_blocks = u32{1} << 22U;

// A 32-byte key. Allocates the cost's memory for the call.
auto argon2id(const argon2id_inputs& inputs, argon2id_cost cost) -> result<secret_key>;

}
