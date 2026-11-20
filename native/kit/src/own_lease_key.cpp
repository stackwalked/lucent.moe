#include "own_lease_key.hpp"

#include <cstddef>
#include <optional>
#include <string_view>

#include <lucent/crypto/crypto.hpp>

namespace lucent::kit::detail {
namespace {

// Defined on this file alone, so a new key rebuilds nothing else: the configured key, 43
// base64url characters without padding, in a Release build; empty in any other. CMake checked its
// alphabet and length.
// NOLINTNEXTLINE(readability-redundant-string-init): the macro is the key in Release, empty only elsewhere.
constexpr std::string_view configured = LUCENT_KIT_LEASE_PUBLIC_KEY;

// Unused in a dev build, which holds no key.
[[maybe_unused]] consteval auto sextet(char digit) -> u32 {
    if (digit >= 'A' && digit <= 'Z') {
        return static_cast<u32>(digit - 'A');
    }
    if (digit >= 'a' && digit <= 'z') {
        return static_cast<u32>(digit - 'a' + 26);
    }
    if (digit >= '0' && digit <= '9') {
        return static_cast<u32>(digit - '0' + 52);
    }
    if (digit == '-') {
        return 62;
    }
    LUCENT_INVARIANT(digit == '_');
    return 63;
}

// On the length, so the branch a build doesn't take is never instantiated.
template <usize Length>
consteval auto parsed() -> std::optional<crypto::public_key> {
    if constexpr (Length == 0) {
        return std::nullopt;
    } else {
        static_assert(Length == 43, "32 bytes are 43 base64url characters unpadded");
        crypto::public_key key{};
        u32 bits = 0;
        u32 held = 0;
        usize written = 0;
        for (const char digit : configured) {
            bits = (bits << 6U) | sextet(digit);
            held += 6;
            if (held >= 8) {
                held -= 8;
                key.at(written) = std::byte{static_cast<u8>(bits >> held)};
                ++written;
                bits &= (u32{1} << held) - 1;
            }
        }
        // The two bits left over are zero in a canonical encoding.
        LUCENT_INVARIANT(written == key.size() && bits == 0);
        return key;
    }
}

constexpr std::optional<crypto::public_key> compiled = parsed<configured.size()>();

}

auto own_lease_key() -> std::optional<crypto::public_key> {
    return compiled;
}

}
