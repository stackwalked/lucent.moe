#pragma once

#include <chrono>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <variant>

#include <lucent/core/stdx/function_ref.hpp>

#include "api/server.hpp"

// Signing the loader in (platform/server/src/native/sign-in.ts): a pushed authorization request
// under DPoP, the member approving it at <web>/auth/device/<id> in the system browser, the code
// back on a loopback redirect with PKCE, then tokens bound to the device key. Refresh tokens
// rotate on every use.

namespace lucent::loader {

inline constexpr std::string_view loader_client_id = "lucent-loader";

struct token_set {
    std::string access_token;
    std::chrono::seconds expires_in{};
    std::string refresh_token;
};

// Why OAuth said no, in its own words (access_denied, invalid_grant, slow_down...).
struct oauth_refusal {
    std::string reason;
};

using sign_in_outcome = std::variant<token_set, oauth_refusal>;

struct form_field {
    std::string_view name;
    std::string_view value;
};

// application/x-www-form-urlencoded, every byte outside the unreserved set percent-encoded.
auto form_encoded(std::span<const form_field> fields) -> std::string;

// The lauth_ id inside a pushed request's request_uri; nothing for any other shape.
auto request_id_of(std::string_view request_uri) -> std::optional<std::string>;

// Shows the member where to approve: the page's URL, and whether the browser opened it.
using show_approval = stdx::function_ref<void(std::string_view url)>;

// The whole browser round trip. The web origin is where the approval page lives.
auto sign_in(server& api, std::string_view web_origin, show_approval show)
    -> result<sign_in_outcome>;

// Trades the refresh token for a new set, or OAuth's reason for not.
auto refresh(server& api, std::string_view refresh_token) -> result<sign_in_outcome>;

// The refresh token and the access token it last bought.
class credentials final {
public:
    explicit credentials(std::string refresh_token);

    // Hands each rotated refresh token to the keeper before using what it bought, so a crash
    // never leaves the saved token one rotation behind (a reused one revokes its whole family).
    using keeper = stdx::function_ref<result<void>(std::string_view refresh_token)>;

    // An access token with at least a minute left, refreshing first when needed. Nothing when the
    // refresh token is spent (invalid_grant), which means signing in again; any other refusal
    // fails as unsupported and keeps the token for the next try.
    auto access_token(server& api, keeper keep) -> result<std::optional<std::string>>;

    // After a fresh sign-in.
    auto replace(const token_set& tokens) -> void;

private:
    std::string m_refresh_token;
    std::string m_access_token;
    std::chrono::steady_clock::time_point m_access_expires;
};

}
