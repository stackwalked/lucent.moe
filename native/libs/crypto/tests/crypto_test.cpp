#include <lucent/crypto/crypto.hpp>

#include <array>
#include <cstddef>
#include <span>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

// Known answers from RFC 8032 (Ed25519) and BLAKE2b's reference vectors. They catch the subtle
// failure: Monocypher's default EdDSA hashes with BLAKE2b, signs fine, and no one else verifies it.

namespace lucent::crypto {
namespace {

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

TEST_CASE("signing with RFC 8032's first key gives its public key and signature, empty message") {
    const signing_key key = signing_key::from_seed(
        bytes_of<32>("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    );

    CHECK(
        key.public_part()
        == bytes_of<32>("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    );
    CHECK(
        key.sign({})
        == bytes_of<64>(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39"
            "701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        )
    );
}

TEST_CASE("signing with RFC 8032's second key gives its signature over one byte") {
    const signing_key key = signing_key::from_seed(
        bytes_of<32>("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    );
    const std::array message{std::byte{0x72}};

    CHECK(
        key.public_part()
        == bytes_of<32>("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
    );
    CHECK(
        key.sign(message)
        == bytes_of<64>(
            "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f36"
            "13d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"
        )
    );
}

TEST_CASE("a signature verifies only for its own key, message and bytes") {
    const signing_key key = signing_key::from_seed(
        bytes_of<32>("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
    );
    const signing_key other = signing_key::from_seed(
        bytes_of<32>("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    );
    const std::array message{std::byte{0x72}};
    const std::array changed{std::byte{0x73}};
    const signature seal = key.sign(message);
    signature flipped = seal;
    flipped.front() ^= std::byte{0x01};

    CHECK(verify(key.public_part(), message, seal).has_value());
    CHECK_FALSE(verify(key.public_part(), changed, seal).has_value());
    CHECK_FALSE(verify(other.public_part(), message, seal).has_value());
    CHECK_FALSE(verify(key.public_part(), message, flipped).has_value());
}

// The answers come from Python's hashlib.blake2b(digest_size=32, key=bytes(range(32))), an
// implementation independent of Monocypher.
TEST_CASE("keyed BLAKE2b-256 gives its known answers") {
    const auto key =
        bytes_of<32>("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
    const std::array abc{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}};

    CHECK(
        keyed_hash(key, {})
        == bytes_of<32>("4e51e7a913fc80137da52880fecca175bf81e117d5c68126dc2774033517ea0d")
    );
    CHECK(
        keyed_hash(key, abc)
        == bytes_of<32>("d63a32d3e44738d7907f964316c241adaba0abfeabc32349677578a15a203f7f")
    );
}

TEST_CASE("BLAKE2b-256 gives its known answers") {
    const std::array abc{std::byte{'a'}, std::byte{'b'}, std::byte{'c'}};

    CHECK(
        hash({}) == bytes_of<32>("0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8")
    );
    CHECK(
        hash(abc)
        == bytes_of<32>("bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319")
    );
}

}
}
