#pragma once

#include <array>
#include <cstddef>
#include <string_view>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

// Deterministic inputs: RFC 8032's test keys, fixed headers, entries derived from their index.

namespace lucent::bundle::fixtures {

consteval auto nibble(char digit) -> u8 {
    if (digit >= '0' && digit <= '9') {
        return static_cast<u8>(digit - '0');
    }
    return static_cast<u8>(digit - 'a' + 10);
}

template <usize Size>
consteval auto bytes_of(std::string_view hex) -> std::array<std::byte, Size> {
    std::array<std::byte, Size> out{};
    for (usize index = 0; index < Size; ++index) {
        const u8 high = nibble(hex.at(2 * index));
        const u8 low = nibble(hex.at((2 * index) + 1));
        out.at(index) = static_cast<std::byte>((u32{high} << 4U) | u32{low});
    }
    return out;
}

inline auto signer() -> crypto::signing_key {
    return crypto::signing_key::from_seed(
        bytes_of<32>("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    );
}

inline auto other_signer() -> crypto::signing_key {
    return crypto::signing_key::from_seed(
        bytes_of<32>("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    );
}

inline auto header_of(std::vector<module_key> modules) -> fact_set_header {
    fact_set_header header;
    header.game = 1;
    header.revision = 3;
    header.modules = std::move(modules);
    header.finders_commit = bytes_of<20>("0123456789abcdef0123456789abcdef01234567");
    header.manifest_digest =
        bytes_of<32>("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");
    return header;
}

inline auto client_module() -> module_key {
    return module_key{
        .name_hash = 0x1111'2222'3333'4444,
        .time_date_stamp = 0x6731'a2f0,
        .size_of_image = 0x04c2'e000,
    };
}

// `size` literal entries; key and value follow from the index.
inline auto fact_set_of(u32 size) -> fact_set {
    std::vector<entry> entries;
    entries.reserve(size);
    for (u32 index = 0; index < size; ++index) {
        entries.push_back(literal(0x1000 + (u64{index} * 0x10), 0xa000 + u64{index}));
    }
    return sign_fact_set(header_of({client_module()}), std::move(entries), signer());
}

}
