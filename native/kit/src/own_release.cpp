#include <lucent/kit/own_release.hpp>

#include <array>
#include <cstddef>
#include <optional>
#include <string_view>

#include <lucent/wire/ids.hpp>

namespace lucent::kit {
namespace {

// Defined on this file alone, so a new id rebuilds nothing else: the configured id in a Release
// build, empty in any other. CMake checked it is 32 lowercase hex digits.
// NOLINTNEXTLINE(readability-redundant-string-init): the macro is the id in Release, empty only elsewhere.
constexpr std::string_view configured = LUCENT_KIT_RELEASE_ID;

// On the length, so the branch a build doesn't take is never instantiated.
template <usize Length>
consteval auto parsed() -> std::optional<wire::release_id> {
    if constexpr (Length == 0) {
        return std::nullopt;
    } else {
        static_assert(Length == 2 * wire::id_size, "CMake checks the id's length");
        const auto nibble = [](char digit) -> u8 {
            if (digit >= '0' && digit <= '9') {
                return static_cast<u8>(digit - '0');
            }
            LUCENT_INVARIANT(digit >= 'a' && digit <= 'f');
            return static_cast<u8>(digit - 'a' + 10);
        };
        wire::release_id id;
        for (usize i = 0; i < wire::id_size; ++i) {
            const u32 high = nibble(configured.at(2 * i));
            const u32 low = nibble(configured.at((2 * i) + 1));
            id.bytes.at(i) = std::byte{static_cast<u8>((high << 4U) | low)};
        }
        return id;
    }
}

constexpr std::optional<wire::release_id> compiled = parsed<configured.size()>();

}

auto own_release() -> std::optional<wire::release_id> {
    return compiled;
}

}
