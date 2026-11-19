#include <lucent/core/identifier_hash.hpp>

#include <array>
#include <cstddef>
#include <string_view>

#include <lucent/core/narrow.hpp>

namespace lucent {
namespace {

// Every expected value below is Python 3's hashlib, an implementation independent of ours:
//   int.from_bytes(hashlib.blake2b(name, key=key, digest_size=8).digest(), "little")
// and a subkey is build_keys.cmake's derivation done there:
//   hashlib.sha3_256((seed.hex() + "lucent::build::" + purpose).encode()).digest()

constexpr auto counting_key() -> identifier_key {
    identifier_key key{};
    for (usize i = 0; i < key.size(); ++i) {
        key.at(i) = std::byte{narrow<u8>(i)};
    }
    return key;
}

constexpr auto nibble(char digit) -> u8 {
    return narrow<u8>(digit <= '9' ? digit - '0' : digit - 'a' + 10);
}

// 64 lowercase hex digits, as Python's bytes.hex() prints a key.
constexpr auto key_from_hex(std::string_view digits) -> identifier_key {
    identifier_key key{};
    for (usize i = 0; i < key.size(); ++i) {
        const u8 high = nibble(digits.at(2 * i));
        const u8 low = nibble(digits.at((2 * i) + 1));
        key.at(i) = std::byte{narrow<u8>((high * 16) + low)};
    }
    return key;
}

template <usize N>
constexpr auto repeated_letter(char letter) -> std::array<char, N> {
    std::array<char, N> text{};
    text.fill(letter);
    return text;
}

template <usize N>
constexpr auto as_view(const std::array<char, N>& text) -> std::string_view {
    return {text.data(), N};
}

constexpr auto x127 = repeated_letter<127>('x');
constexpr auto x128 = repeated_letter<128>('x');
constexpr auto x129 = repeated_letter<129>('x');
constexpr auto y300 = repeated_letter<300>('y');

constexpr identifier_key zero_key{};
constexpr identifier_key counting = counting_key();
// The fact subkey of the dev seed (32 zero bytes), and of a stand-in release seed (bytes 1..32).
constexpr identifier_key dev_fact_subkey =
    key_from_hex("894f29847bc4a99310b4577a339fb73eaba78706aa987d3b0c2fed21d4bcc72f");
constexpr identifier_key release_fact_subkey =
    key_from_hex("5d954f89297096d656326049b44a61ed34407a65e54c86b425d9147f5fc09e17");

static_assert(identifier_hash(zero_key, "") == 0x7bec'b88c'f26f'd636, "the key block alone");
static_assert(identifier_hash(zero_key, "abc") == 0x6e12'2648'de4c'dde0);
static_assert(identifier_hash(zero_key, "entity_system") == 0xac82'c2af'9cd3'e198);
static_assert(identifier_hash(zero_key, as_view(x127)) == 0x8b01'8ba9'a220'c046);
static_assert(
    identifier_hash(zero_key, as_view(x128)) == 0xa43e'6633'3b9e'6e4e,
    "a name that fills its block exactly ends on it"
);
static_assert(identifier_hash(zero_key, as_view(x129)) == 0xbf31'0a9c'6e4a'e91a);
static_assert(identifier_hash(zero_key, as_view(y300)) == 0xe874'5286'c04a'2ab4);

static_assert(identifier_hash(counting, "") == 0xda23'b69e'45e0'fbb6);
static_assert(identifier_hash(counting, "abc") == 0xefcd'34ec'411c'5330);
static_assert(identifier_hash(counting, "entity_system") == 0xc8e0'15d1'375d'713a);
static_assert(identifier_hash(counting, as_view(x127)) == 0x6950'608c'8b01'1301);
static_assert(identifier_hash(counting, as_view(x128)) == 0x9b2a'6e86'cd9c'3183);
static_assert(identifier_hash(counting, as_view(x129)) == 0xeac5'ee73'1db1'239c);
static_assert(identifier_hash(counting, as_view(y300)) == 0x32fd'0b10'0cf5'3ed1);

static_assert(identifier_hash(dev_fact_subkey, "entity_system") == 0x4634'7ebc'01d3'8495);
static_assert(identifier_hash(release_fact_subkey, "entity_system") == 0x29e6'a27c'dd26'000e);
static_assert(
    identifier_hash(dev_fact_subkey, "entity_system")
        != identifier_hash(release_fact_subkey, "entity_system"),
    "a fact's key differs between the dev and a release subkey"
);

}
}
