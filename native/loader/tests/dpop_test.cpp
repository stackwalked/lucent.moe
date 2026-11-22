#include "api/dpop.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <Windows.h>

#include <bcrypt.h>
#include <catch2/catch_test_macros.hpp>

#include "cng/device_key.hpp"
#include "cng/sha256.hpp"
#include "text/base64url.hpp"
#include "text/json.hpp"
#include "text/text_bytes.hpp"

namespace lucent::loader {
namespace {

// x is the bytes 0..31 and y 32..63: not a point on the curve, which a thumbprint doesn't need.
auto counting_point() -> p256_point {
    p256_point point;
    for (usize at = 0; at < p256_coordinate_size; ++at) {
        point.x.at(at) = std::byte{static_cast<u8>(at)};
        point.y.at(at) = std::byte{static_cast<u8>(at + p256_coordinate_size)};
    }
    return point;
}

struct split_jws {
    std::string header;
    std::string payload;
    std::string signing_input;
    std::vector<std::byte> signature;
};

auto split(std::string_view jws) -> split_jws {
    const usize first = jws.find('.');
    const usize second = jws.find('.', first + 1);
    REQUIRE(second != std::string_view::npos);
    const auto decode = [](std::string_view part) {
        const std::optional<std::vector<std::byte>> bytes = from_base64url(part);
        REQUIRE(bytes);
        return *bytes;
    };
    const std::vector<std::byte> header = decode(jws.substr(0, first));
    const std::vector<std::byte> payload = decode(jws.substr(first + 1, second - first - 1));
    return split_jws{
        .header = std::string{as_text(header)},
        .payload = std::string{as_text(payload)},
        .signing_input = std::string{jws.substr(0, second)},
        .signature = decode(jws.substr(second + 1)),
    };
}

// ES256 checked by CNG against the key's public point, as jose checks it on the server.
auto verifies(
    const p256_point& point, std::string_view message, std::span<const std::byte> signature
) -> bool {
    std::array<std::byte, sizeof(BCRYPT_ECCKEY_BLOB) + (2 * p256_coordinate_size)> blob{};
    const BCRYPT_ECCKEY_BLOB header{
        .dwMagic = BCRYPT_ECDSA_PUBLIC_P256_MAGIC,
        .cbKey = p256_coordinate_size,
    };
    std::ranges::copy(std::as_bytes(std::span{&header, 1}), blob.begin());
    std::ranges::copy(point.x, blob.begin() + sizeof(header));
    std::ranges::copy(point.y, blob.begin() + sizeof(header) + p256_coordinate_size);
    BCRYPT_KEY_HANDLE key = nullptr;
    // NOLINTBEGIN(cppcoreguidelines-pro-type-reinterpret-cast,cppcoreguidelines-pro-type-const-cast): CNG takes PUCHAR buffers.
    const NTSTATUS imported = BCryptImportKeyPair(
        BCRYPT_ECDSA_P256_ALG_HANDLE,
        nullptr,
        BCRYPT_ECCPUBLIC_BLOB,
        &key,
        reinterpret_cast<PUCHAR>(blob.data()),
        static_cast<ULONG>(blob.size()),
        0
    );
    REQUIRE(BCRYPT_SUCCESS(imported));
    sha256_digest digest = sha256(as_bytes(message));
    const NTSTATUS checked = BCryptVerifySignature(
        key,
        nullptr,
        reinterpret_cast<PUCHAR>(digest.data()),
        static_cast<ULONG>(digest.size()),
        const_cast<PUCHAR>(reinterpret_cast<const UCHAR*>(signature.data())),
        static_cast<ULONG>(signature.size()),
        0
    );
    // NOLINTEND(cppcoreguidelines-pro-type-reinterpret-cast,cppcoreguidelines-pro-type-const-cast)
    BCryptDestroyKey(key);
    return BCRYPT_SUCCESS(checked);
}

TEST_CASE("the thumbprint and match code are the platform's for the same key") {
    // Computed by jose's calculateJwkThumbprint and platform/server/src/native/ids.ts's
    // matchCodeOf for this JWK.
    REQUIRE(thumbprint_of(counting_point()) == "0r62zgBj277RicA3LnaBKQ5_9RCDIomrlbpWjO0QTG0");
    REQUIRE(match_code_of(counting_point()) == "TAZB-DKG0");
}

TEST_CASE("a proof names the request and verifies under the key in its own header") {
    const result<device_key> key = device_key::ephemeral();
    REQUIRE(key);
    const result<std::string> proof = dpop_proof(
        *key,
        proof_claims{
            .method = "POST",
            .url = "https://api.lucent.moe/v1/starts",
            .access_token = std::nullopt,
            .issued_at = 1'763'700'000,
            .proof_id = "AAAAAAAAAAAAAAAAAAAAAA",
        }
    );
    REQUIRE(proof);
    const split_jws parts = split(*proof);
    REQUIRE(
        parts.header
        == std::string{R"({"typ":"dpop+jwt","alg":"ES256","jwk":)"} + jwk_json(key->public_point())
               + "}"
    );
    const result<json_object> claims = parse_flat_object(parts.payload);
    REQUIRE(claims);
    REQUIRE(string_member(*claims, "htm") == "POST");
    REQUIRE(string_member(*claims, "htu") == "https://api.lucent.moe/v1/starts");
    REQUIRE(integer_member(*claims, "iat") == 1'763'700'000);
    REQUIRE(string_member(*claims, "jti") == "AAAAAAAAAAAAAAAAAAAAAA");
    REQUIRE_FALSE(claims->contains("ath"));
    REQUIRE(verifies(key->public_point(), parts.signing_input, parts.signature));
}

TEST_CASE(
    "a proof with an access token carries the token's hash, so it can't be moved to another"
) {
    const result<device_key> key = device_key::ephemeral();
    REQUIRE(key);
    const result<std::string> proof = dpop_proof(
        *key,
        proof_claims{
            .method = "GET",
            .url = "https://api.lucent.moe/v1/loader",
            .access_token = "lat_token",
            .issued_at = 1,
            .proof_id = "BBBBBBBBBBBBBBBBBBBBBB",
        }
    );
    REQUIRE(proof);
    const result<json_object> claims = parse_flat_object(split(*proof).payload);
    REQUIRE(claims);
    REQUIRE(string_member(*claims, "ath") == to_base64url(sha256(as_bytes("lat_token"))));
}

}
}
