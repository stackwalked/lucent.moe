#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>
#include <monocypher-ed25519.h>
#include <monocypher.h>

#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

#include "hex.hpp"

// contracts/ed25519/v1/strict.json: signatures that a cofactorless or cofactored Ed25519 verifier
// accepts and a strict one refuses (an unreduced S, a small-order or non-canonically encoded key
// or R), beside one valid signature. Both sides of the platform must refuse every one marked
// invalid; the TS server checks the same file. Rewritten with LUCENT_WRITE_VECTORS=1
// (`moon run crypto:vectors`); review the diff.
//
// The constructions need nothing but scalar arithmetic and base-point multiplication, so they use
// Monocypher's low-level EdDSA calls directly, which nothing outside these tests may.

namespace lucent::crypto {
namespace {

using bytes32 = std::array<std::byte, 32>;

struct strict_case {
    std::string_view name;
    // What a strict verifier refuses it for; empty for the valid case.
    std::string_view defect;
    bytes32 public_key{};
    std::vector<std::byte> message;
    signature seal{};
};

auto writable_u8(std::span<std::byte> bytes) -> u8* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): Monocypher takes u8; same object representation.
    return reinterpret_cast<u8*>(bytes.data());
}

auto as_u8(std::span<const std::byte> bytes) -> const u8* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): as above.
    return reinterpret_cast<const u8*>(bytes.data());
}

// RFC 8032's first test key.
constexpr seed signer_seed =
    test::bytes_of<32>("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
// RFC 8032's second test key, whose public key serves as a full-order R of known logarithm.
constexpr seed nonce_seed =
    test::bytes_of<32>("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb");

// The group order L, little-endian.
constexpr bytes32 group_order =
    test::bytes_of<32>("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");

// Encodings of small-order points, from libsodium's blocklist (ge25519_has_small_order). The
// identity is (0, 1); p + 1 and (0, 1) with the sign bit set encode it again, non-canonically.
// (0, -1) has order 2.
constexpr bytes32 identity =
    test::bytes_of<32>("0100000000000000000000000000000000000000000000000000000000000000");
constexpr bytes32 identity_above_p =
    test::bytes_of<32>("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
constexpr bytes32 identity_negative_zero =
    test::bytes_of<32>("0100000000000000000000000000000000000000000000000000000000000080");
constexpr bytes32 order_two =
    test::bytes_of<32>("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");
constexpr bytes32 order_eight =
    test::bytes_of<32>("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a");
// The same point's negation (sign bit set), and the other y of order 8, p minus the first.
constexpr bytes32 order_eight_negated =
    test::bytes_of<32>("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa");
constexpr bytes32 order_eight_other =
    test::bytes_of<32>("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05");
// y = 0: the two points of order 4, x = sqrt(-1) and its negation.
constexpr bytes32 order_four{};
constexpr bytes32 order_four_negated =
    test::bytes_of<32>("0000000000000000000000000000000000000000000000000000000000000080");

auto base_message() -> std::vector<std::byte> {
    constexpr std::string_view text = "lucent strict ed25519";
    const std::span<const std::byte> bytes = std::as_bytes(std::span{text});
    return {bytes.begin(), bytes.end()};
}

// The clamped secret scalar Ed25519 derives from a seed, reduced mod L.
auto scalar_of(const seed& material) -> bytes32 {
    std::array<std::byte, 64> expanded{};
    crypto_sha512(writable_u8(expanded), as_u8(material), material.size());
    bytes32 clamped{};
    crypto_eddsa_trim_scalar(writable_u8(clamped), as_u8(std::span{expanded}.first(32)));
    std::array<std::byte, 64> wide{};
    std::ranges::copy(clamped, wide.begin());
    bytes32 reduced{};
    crypto_eddsa_reduce(writable_u8(reduced), as_u8(wide));
    return reduced;
}

// k = SHA-512(R || A || M) mod L, the challenge every verifier recomputes.
auto challenge_of(const bytes32& point_r, const bytes32& key, std::span<const std::byte> message)
    -> bytes32 {
    std::vector<std::byte> input;
    input.append_range(point_r);
    input.append_range(key);
    input.append_range(message);
    std::array<std::byte, 64> expanded{};
    crypto_sha512(writable_u8(expanded), as_u8(input), input.size());
    bytes32 reduced{};
    crypto_eddsa_reduce(writable_u8(reduced), as_u8(expanded));
    return reduced;
}

auto signature_of(const bytes32& point_r, const bytes32& scalar_s) -> signature {
    signature out{};
    std::ranges::copy(point_r, out.begin());
    std::ranges::copy(scalar_s, out.begin() + 32);
    return out;
}

auto valid_case() -> strict_case {
    const signing_key signer = signing_key::from_seed(signer_seed);
    const std::vector<std::byte> message = base_message();
    return strict_case{
        .name = "valid",
        .defect = "",
        .public_key = signer.public_part(),
        .message = message,
        .seal = signer.sign(message),
    };
}

// S + L: the same point equation, an S no canonical signer produces (malleability).
auto unreduced_s_case() -> strict_case {
    strict_case out = valid_case();
    u32 carry = 0;
    for (usize index = 0; index < 32; ++index) {
        const u32 sum = static_cast<u32>(out.seal.at(32 + index))
                        + static_cast<u32>(group_order.at(index)) + carry;
        out.seal.at(32 + index) = static_cast<std::byte>(sum & 0xffU);
        carry = sum >> 8U;
    }
    out.name = "s_unreduced";
    out.defect = "S is not below L";
    return out;
}

// The signer's real key with R a small-order point: S = k a makes [S]B = R + [k]A hold whenever
// R is the identity, however it is encoded, and makes the cofactored equation (Monocypher's) hold
// for any small-order R.
auto small_r_case(std::string_view name, std::string_view defect, const bytes32& point_r)
    -> strict_case {
    const signing_key signer = signing_key::from_seed(signer_seed);
    const std::vector<std::byte> message = base_message();
    const bytes32 challenge = challenge_of(point_r, signer.public_part(), message);
    const bytes32 secret = scalar_of(signer_seed);
    const bytes32 zero{};
    bytes32 scalar_s{};
    crypto_eddsa_mul_add(writable_u8(scalar_s), as_u8(challenge), as_u8(secret), as_u8(zero));
    return strict_case{
        .name = name,
        .defect = defect,
        .public_key = signer.public_part(),
        .message = message,
        .seal = signature_of(point_r, scalar_s),
    };
}

// A small-order key: with R = [s]B and S = s the equation is [s]B = [s]B + [k]A, which holds when
// [k]A is the identity, so the message gets a counter byte until k is a multiple of A's order.
auto small_key_case(std::string_view name, std::string_view defect, const bytes32& key, u32 order)
    -> strict_case {
    const bytes32 scalar_s = scalar_of(nonce_seed);
    bytes32 point_r{};
    crypto_eddsa_scalarbase(writable_u8(point_r), as_u8(scalar_s));
    std::vector<std::byte> message = base_message();
    message.push_back(std::byte{0});
    while (static_cast<u32>(challenge_of(point_r, key, message).front()) % order != 0) {
        message.back() = static_cast<std::byte>(static_cast<u32>(message.back()) + 1);
    }
    return strict_case{
        .name = name,
        .defect = defect,
        .public_key = key,
        .message = message,
        .seal = signature_of(point_r, scalar_s),
    };
}

auto cases() -> std::vector<strict_case> {
    return {
        valid_case(),
        unreduced_s_case(),
        small_r_case("r_identity", "R is of small order", identity),
        small_r_case("r_identity_above_p", "R is encoded with y not below p", identity_above_p),
        small_r_case(
            "r_identity_negative_zero",
            "R is encoded with x = 0 and the sign bit set",
            identity_negative_zero
        ),
        small_r_case("r_order_eight", "R is of small order", order_eight),
        small_key_case("key_identity", "the key is of small order", identity, 1),
        small_key_case("key_order_two", "the key is of small order", order_two, 2),
        small_key_case("key_order_four", "the key is of small order", order_four, 4),
        small_key_case(
            "key_order_four_negated", "the key is of small order", order_four_negated, 4
        ),
        small_key_case("key_order_eight", "the key is of small order", order_eight, 8),
        small_key_case(
            "key_order_eight_negated", "the key is of small order", order_eight_negated, 8
        ),
        small_key_case("key_order_eight_other", "the key is of small order", order_eight_other, 8),
        small_key_case(
            "key_identity_above_p", "the key is encoded with y not below p", identity_above_p, 1
        ),
        small_key_case(
            "key_identity_negative_zero",
            "the key is encoded with x = 0 and the sign bit set",
            identity_negative_zero,
            1
        ),
    };
}

auto json_of(const std::vector<strict_case>& all) -> std::string {
    std::string out = "{\n  \"cases\": [\n";
    for (usize index = 0; const strict_case& each : all) {
        out += std::format(
            "    {{\n"
            "      \"name\": \"{}\",\n"
            "      \"is_valid\": {},\n"
            "      \"defect\": \"{}\",\n"
            "      \"public_key\": \"{}\",\n"
            "      \"message\": \"{}\",\n"
            "      \"signature\": \"{}\"\n"
            "    }}{}\n",
            each.name,
            each.defect.empty() ? "true" : "false",
            each.defect,
            test::hex_of(each.public_key),
            test::hex_of(each.message),
            test::hex_of(each.seal),
            index + 1 < all.size() ? "," : ""
        );
        ++index;
    }
    return out + "  ]\n}\n";
}

auto vector_path() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / "ed25519" / "v1" / "strict.json";
}

auto should_write() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_WRITE_VECTORS", value.data(), 2) == 1
           && value.front() == L'1';
}

auto case_named(std::string_view name) -> strict_case {
    for (strict_case& each : cases()) {
        if (each.name == name) {
            return std::move(each);
        }
    }
    LUCENT_UNREACHABLE();
}

auto is_accepted(std::string_view name) -> bool {
    const strict_case each = case_named(name);
    return verify(each.public_key, each.message, each.seal).has_value();
}

TEST_CASE("the strict Ed25519 golden vectors are exactly what their constructions give") {
    const std::string json = json_of(cases());
    if (should_write()) {
        std::filesystem::create_directories(vector_path().parent_path());
        REQUIRE(os::write_file(vector_path(), std::as_bytes(std::span{json})).has_value());
    }
    const result<std::vector<std::byte>> stored = os::read_file(vector_path());

    REQUIRE(stored.has_value());
    CHECK(std::ranges::equal(*stored, std::as_bytes(std::span{json})));
}

TEST_CASE("verification accepts the valid strict vector") {
    CHECK(is_accepted("valid"));
}

TEST_CASE("verification refuses a signature whose S is not reduced") {
    CHECK_FALSE(is_accepted("s_unreduced"));
}

TEST_CASE("verification refuses every strict vector marked invalid") {
    for (const strict_case& each : cases()) {
        if (each.defect.empty()) {
            continue;
        }
        INFO(each.name);
        CHECK_FALSE(verify(each.public_key, each.message, each.seal).has_value());
    }
}

// What makes the vectors worth having: Monocypher 4.0.2's own check accepts each of them, so
// verify()'s pre-check is what refuses them.
TEST_CASE("Monocypher's own check accepts every invalid strict vector but the unreduced S") {
    for (const strict_case& each : cases()) {
        if (each.defect.empty() || each.name == "s_unreduced") {
            continue;
        }
        INFO(each.name);
        CHECK(
            crypto_ed25519_check(
                as_u8(each.seal), as_u8(each.public_key), as_u8(each.message), each.message.size()
            )
            == 0
        );
    }
}

}
}
