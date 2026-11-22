#pragma once

#include <array>
#include <cstddef>
#include <span>

#include <lucent/wire/enrollment.hpp>

namespace lucent::loader {

inline constexpr usize p256_coordinate_size = 32;
inline constexpr usize es256_signature_size = 64;

// A P-256 public key as JOSE spells it: the two coordinates, big-endian.
struct p256_point {
    std::array<std::byte, p256_coordinate_size> x{};
    std::array<std::byte, p256_coordinate_size> y{};

    auto operator==(const p256_point&) const -> bool = default;
};

// ES256's signature (RFC 7518 §3.4): r then s, 32 bytes each.
using es256_signature = std::array<std::byte, es256_signature_size>;

// The PC's key: the DPoP key of every /v1 request, so sign-in, enrollment and every later call
// prove the same PC. Kept in the TPM through the Platform Crypto Provider where there is one, else
// as a non-exportable software key; the platform records which.
class device_key final {
public:
    // The key this Windows user made on this PC before, or a new one. A TPM key is looked for and
    // made first, so a PC that gains a TPM keeps its software key until that is removed.
    static auto open_or_create() -> result<device_key>;

    // A software key that lives only as long as this object, for tests.
    static auto ephemeral() -> result<device_key>;

    device_key(const device_key&) = delete ("one handle per key");
    auto operator=(const device_key&) -> device_key& = delete ("one handle per key");
    device_key(device_key&& other) noexcept;
    auto operator=(device_key&&) -> device_key& = delete ("one handle per key");
    ~device_key();

    auto storage() const -> wire::key_storage;
    auto public_point() const -> const p256_point&;

    // SHA-256 of the message, signed.
    auto sign(std::span<const std::byte> message) const -> result<es256_signature>;

private:
    device_key(uptr handle, wire::key_storage storage, p256_point point);

    // An NCRYPT_KEY_HANDLE; 0 once moved from.
    uptr m_handle;
    wire::key_storage m_storage;
    p256_point m_point;
};

}
