#pragma once

#include <array>
#include <cstddef>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// Known answers are written as lowercase hex, as their sources print them.

namespace lucent::crypto::test {

constexpr auto nibble(char digit) -> u8 {
    if (digit >= '0' && digit <= '9') {
        return static_cast<u8>(digit - '0');
    }
    return static_cast<u8>(digit - 'a' + 10);
}

constexpr auto byte_at(std::string_view hex, usize index) -> std::byte {
    const u8 high = nibble(hex.at(2 * index));
    const u8 low = nibble(hex.at((2 * index) + 1));
    return static_cast<std::byte>((u32{high} << 4U) | u32{low});
}

template <usize Size>
consteval auto bytes_of(std::string_view hex) -> std::array<std::byte, Size> {
    std::array<std::byte, Size> out{};
    for (usize index = 0; index < Size; ++index) {
        out.at(index) = byte_at(hex, index);
    }
    return out;
}

inline auto vector_of(std::string_view hex) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.reserve(hex.size() / 2);
    for (usize index = 0; index < hex.size() / 2; ++index) {
        out.push_back(byte_at(hex, index));
    }
    return out;
}

inline auto hex_of(std::span<const std::byte> bytes) -> std::string {
    std::string out;
    for (const std::byte value : bytes) {
        out += std::format("{:02x}", static_cast<u8>(value));
    }
    return out;
}

}
