#include <lucent/menu/text_key.hpp>

#include <string>
#include <utility>

#include <lucent/core/match.hpp>

namespace lucent::menu {
namespace {

auto hash_of(const text_key& key) -> u64 {
    return match(
        key,
        [](const feature_text& named) { return std::to_underlying(named.feature); },
        [](const setting_text& named) { return std::to_underlying(named.setting); },
        [](const option_text& named) { return std::to_underlying(named.option); },
        [](const phrase_text& named) { return std::to_underlying(named.phrase); },
        // In the top byte, which the placeholder shows: "#41000000" for the A key.
        [](const key_text& named) { return u64{std::to_underlying(named.key)} << 56U; }
    );
}

// Spelled out rather than through a format string or a digit table: either would put a printable
// run into the image for the release string gate to find.
auto hex_digit(u64 nibble) -> char {
    return nibble < 10U ? static_cast<char>('0' + nibble) : static_cast<char>('a' + nibble - 10U);
}

// Enough to tell the entries of one page apart.
constexpr u32 placeholder_digits = 8;

}

auto placeholder(const text_key& key) -> std::string {
    const u64 hash = hash_of(key);
    std::string shown{'#'};
    for (u32 digit = 0; digit < placeholder_digits; ++digit) {
        shown.push_back(hex_digit((hash >> (60U - (digit * 4U))) & 0xfU));
    }
    return shown;
}

}
