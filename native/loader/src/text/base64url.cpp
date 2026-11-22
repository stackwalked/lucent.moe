#include "text/base64url.hpp"

#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace lucent::loader {
namespace {

constexpr std::string_view alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
constexpr std::string_view hex_digits = "0123456789abcdef";

auto sextet_of(char digit) -> std::optional<u32> {
    const usize position = alphabet.find(digit);
    if (position == std::string_view::npos) {
        return std::nullopt;
    }
    return static_cast<u32>(position);
}

auto nibble_of(char digit) -> std::optional<u8> {
    const usize position = hex_digits.find(digit);
    if (position == std::string_view::npos) {
        return std::nullopt;
    }
    return static_cast<u8>(position);
}

}

auto to_base64url(std::span<const std::byte> bytes) -> std::string {
    std::string text;
    text.reserve(((bytes.size() * 4) + 2) / 3);
    u32 bits = 0;
    u32 held = 0;
    for (const std::byte value : bytes) {
        bits = (bits << 8U) | std::to_integer<u32>(value);
        held += 8;
        while (held >= 6) {
            held -= 6;
            text.push_back(alphabet.at((bits >> held) & 0x3fU));
        }
    }
    if (held > 0) {
        text.push_back(alphabet.at((bits << (6 - held)) & 0x3fU));
    }
    return text;
}

auto from_base64url(std::string_view text) -> std::optional<std::vector<std::byte>> {
    // A length of 1 mod 4 leaves 6 bits, not a byte: no encoder writes it.
    if (text.size() % 4 == 1) {
        return std::nullopt;
    }
    std::vector<std::byte> bytes;
    bytes.reserve((text.size() * 3) / 4);
    u32 bits = 0;
    u32 held = 0;
    for (const char digit : text) {
        const std::optional<u32> sextet = sextet_of(digit);
        if (!sextet) {
            return std::nullopt;
        }
        bits = (bits << 6U) | *sextet;
        held += 6;
        if (held >= 8) {
            held -= 8;
            bytes.push_back(std::byte{static_cast<u8>(bits >> held)});
            bits &= (u32{1} << held) - 1;
        }
    }
    if (bits != 0) {
        return std::nullopt;
    }
    return bytes;
}

auto to_hex(std::span<const std::byte> bytes) -> std::string {
    std::string text;
    text.reserve(bytes.size() * 2);
    for (const std::byte value : bytes) {
        const u32 octet = std::to_integer<u32>(value);
        text.push_back(hex_digits.at(octet >> 4U));
        text.push_back(hex_digits.at(octet & 0xfU));
    }
    return text;
}

auto from_hex(std::string_view text) -> std::optional<std::vector<std::byte>> {
    if (text.size() % 2 != 0) {
        return std::nullopt;
    }
    std::vector<std::byte> bytes;
    bytes.reserve(text.size() / 2);
    for (usize index = 0; index < text.size(); index += 2) {
        const std::optional<u8> high = nibble_of(text.at(index));
        const std::optional<u8> low = nibble_of(text.at(index + 1));
        if (!high || !low) {
            return std::nullopt;
        }
        bytes.push_back(std::byte{static_cast<u8>((u32{*high} << 4U) | u32{*low})});
    }
    return bytes;
}

}
