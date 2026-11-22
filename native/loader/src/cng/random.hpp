#pragma once

#include <cstddef>
#include <span>
#include <string>

namespace lucent::loader {

// The system's CSPRNG (BCryptGenRandom). It fails only on a broken system, which fails fast.
auto fill_random(std::span<std::byte> into) -> void;

// That many random bytes in base64url: nonces, PKCE verifiers, operation ids.
auto random_token(usize byte_count) -> std::string;

}
