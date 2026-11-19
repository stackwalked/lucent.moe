#pragma once

#include <array>
#include <compare>
#include <cstddef>

// The identities the /v1 messages carry. The platform names its rows `<prefix>_` plus 22
// base64url characters of 16 random bytes; the wire carries the 16 bytes, the field says which
// kind. Release ids are 16 bytes the build draws beside the release's master seed, so a module
// knows its own before any signed list names it.

namespace lucent::wire {

inline constexpr usize id_size = 16;

struct session_id {
    std::array<std::byte, id_size> bytes{};

    auto operator<=>(const session_id&) const = default;
};

struct device_id {
    std::array<std::byte, id_size> bytes{};

    auto operator<=>(const device_id&) const = default;
};

struct release_id {
    std::array<std::byte, id_size> bytes{};

    auto operator<=>(const release_id&) const = default;
};

struct start_id {
    std::array<std::byte, id_size> bytes{};

    auto operator<=>(const start_id&) const = default;
};

struct enrollment_id {
    std::array<std::byte, id_size> bytes{};

    auto operator<=>(const enrollment_id&) const = default;
};

// The release channels of products/*.toml, in their order there.
enum class channel : u8 {
    stable = 0,
    alpha = 1,
    debug = 2,
};

// A product id from products/*.toml: 1 to 32 bytes of [a-z0-9-], length-prefixed on the wire.
inline constexpr usize max_product_size = 32;

}
