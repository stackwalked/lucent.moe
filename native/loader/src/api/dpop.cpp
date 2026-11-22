#include "api/dpop.hpp"

#include <cstddef>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "cng/device_key.hpp"
#include "cng/sha256.hpp"
#include "text/base64url.hpp"
#include "text/json.hpp"

namespace lucent::loader {
namespace {

auto bytes_of(std::string_view text) -> std::span<const std::byte> {
    return std::as_bytes(std::span{text});
}

// Crockford's base32: no I, L, O or U, so a code read off one screen and checked against
// another has no look-alikes. The platform's alphabet, letter for letter.
constexpr std::string_view crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
constexpr usize match_code_bytes = 5;

}

auto jwk_json(const p256_point& point) -> std::string {
    return std::format(
        R"({{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}})",
        to_base64url(point.x),
        to_base64url(point.y)
    );
}

auto thumbprint_of(const p256_point& point) -> std::string {
    return to_base64url(sha256(bytes_of(jwk_json(point))));
}

auto match_code_of(const p256_point& point) -> std::string {
    const sha256_digest digest = sha256(bytes_of(jwk_json(point)));
    u64 bits = 0;
    for (const std::byte value : std::span{digest}.first(match_code_bytes)) {
        bits = (bits << 8U) | std::to_integer<u64>(value);
    }
    std::string code;
    for (u32 shift = 35;; shift -= 5) {
        code.push_back(crockford.at((bits >> shift) & 0x1fU));
        if (code.size() == 4) {
            code.push_back('-');
        }
        if (shift == 0) {
            return code;
        }
    }
}

auto dpop_proof(const device_key& key, const proof_claims& claims) -> result<std::string> {
    const std::string header =
        std::format(R"({{"typ":"dpop+jwt","alg":"ES256","jwk":{}}})", jwk_json(key.public_point()));
    std::string payload = std::format(
        R"({{"jti":{},"htm":{},"htu":{},"iat":{})",
        to_json_string(claims.proof_id),
        to_json_string(claims.method),
        to_json_string(claims.url),
        claims.issued_at
    );
    if (claims.access_token) {
        payload.append(R"(,"ath":)")
            .append(to_json_string(to_base64url(sha256(bytes_of(*claims.access_token)))));
    }
    payload.push_back('}');
    std::string signing_input = to_base64url(bytes_of(header));
    signing_input.push_back('.');
    signing_input.append(to_base64url(bytes_of(payload)));
    const es256_signature signature = LUCENT_TRY(key.sign(bytes_of(signing_input)));
    signing_input.push_back('.');
    signing_input.append(to_base64url(signature));
    return signing_input;
}

}
