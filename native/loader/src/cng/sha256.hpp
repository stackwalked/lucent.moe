#pragma once

#include <array>
#include <cstddef>
#include <span>

namespace lucent::loader {

inline constexpr usize sha256_size = 32;

using sha256_digest = std::array<std::byte, sha256_size>;

// SHA-256 through CNG: what JOSE hashes with (ES256, the JWK thumbprint, DPoP's ath, PKCE's S256).
// Our own digests are BLAKE2b (lucent/crypto).
auto sha256(std::span<const std::byte> message) -> sha256_digest;

}
