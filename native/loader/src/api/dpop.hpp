#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "cng/device_key.hpp"

// DPoP (RFC 9449) with the device key. Every /v1 request carries a proof the platform checks in
// platform/server/src/edge/listeners/native/dpop.ts: ES256 under the JWK in its header, `htm` and
// `htu` naming this exact request, `iat` inside its window, a `jti` it hasn't seen, and with an
// access token, `ath` its hash.

namespace lucent::loader {

// The key as a JWK in RFC 7638's form: the required members in lexicographic order, no spaces,
// which is both the thumbprint's input and what the proof's header carries.
auto jwk_json(const p256_point& point) -> std::string;

// The RFC 7638 SHA-256 thumbprint, base64url: what the platform binds devices and tokens to.
auto thumbprint_of(const p256_point& point) -> std::string;

// What the member compares before approving the PC: the thumbprint's first 40 bits as eight
// Crockford base32 characters, `XXXX-XXXX`, as platform/server/src/base/core/ids.ts derives it.
auto match_code_of(const p256_point& point) -> std::string;

struct proof_claims {
    std::string_view method;
    // The public URL as the loader addressed it, origin and path.
    std::string_view url;
    std::optional<std::string_view> access_token;
    // Seconds since the Unix epoch, by the server's clock as best the loader knows it.
    i64 issued_at = 0;
    // Unique per proof: 16 to 128 visible ASCII characters.
    std::string_view proof_id;
};

// The compact JWS for the DPoP header.
auto dpop_proof(const device_key& key, const proof_claims& claims) -> result<std::string>;

}
