#include "account/sign_in.hpp"

#include <array>
#include <chrono>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <Windows.h>

#include <shellapi.h>

#include <lucent/core/match.hpp>
#include <lucent/core/text.hpp>

#include "account/callback.hpp"
#include "api/server.hpp"
#include "cng/random.hpp"
#include "cng/sha256.hpp"
#include "text/base64url.hpp"
#include "text/json.hpp"
#include "text/text_bytes.hpp"

namespace lucent::loader {
namespace {

constexpr std::string_view request_uri_prefix = "urn:ietf:params:oauth:request_uri:";
// RFC 7636 §4.1: 32 random bytes make a 43-character verifier.
constexpr usize verifier_bytes = 32;
constexpr usize state_bytes = 16;
// The longest the member may take in the browser: the pushed request's own lifetime caps it.
constexpr std::chrono::seconds longest_wait{600};
// An access token this close to its end is refreshed first: a renewal may queue behind others.
constexpr std::chrono::seconds refresh_margin{60};

auto is_unreserved(char letter) -> bool {
    return (letter >= 'A' && letter <= 'Z')
           || (letter >= 'a' && letter <= 'z')
           || (letter >= '0' && letter <= '9')
           || letter == '-'
           || letter == '.'
           || letter == '_'
           || letter == '~';
}

auto percent_encoded(std::string_view text) -> std::string {
    std::string encoded;
    for (const char letter : text) {
        if (is_unreserved(letter)) {
            encoded.push_back(letter);
        } else {
            encoded.append(std::format("%{:02X}", static_cast<u8>(letter)));
        }
    }
    return encoded;
}

auto state_of(const callback_result& came_back) -> std::string_view {
    return match(
        came_back,
        [](const authorized& granted) -> std::string_view { return granted.state; },
        [](const denied& refused) -> std::string_view { return refused.state; }
    );
}

auto tokens_of(const oauth_answer& answered) -> sign_in_outcome {
    if (answered.status != 200) {
        return oauth_refusal{
            .reason = string_member(answered.body, "error").value_or("server_error"),
        };
    }
    const std::optional<std::string> access = string_member(answered.body, "access_token");
    const std::optional<std::string> refreshed = string_member(answered.body, "refresh_token");
    const std::optional<i64> expires = integer_member(answered.body, "expires_in");
    const std::optional<std::string> type = string_member(answered.body, "token_type");
    if (!access || !refreshed || !expires || *expires <= 0 || type != "DPoP") {
        return oauth_refusal{.reason = "server_error"};
    }
    return token_set{
        .access_token = *access,
        .expires_in = std::chrono::seconds{*expires},
        .refresh_token = *refreshed,
    };
}

auto granted_of(const callback_result& came_back) -> std::optional<authorized> {
    return match(
        came_back,
        [](const authorized& granted) { return std::optional<authorized>{granted}; },
        [](const denied& /*refused*/) { return std::optional<authorized>{}; }
    );
}

auto issued_of(const sign_in_outcome& outcome) -> std::optional<token_set> {
    return match(
        outcome,
        [](const token_set& issued) { return std::optional<token_set>{issued}; },
        [](const oauth_refusal& /*refused*/) { return std::optional<token_set>{}; }
    );
}

auto open_in_browser(std::string_view url) -> void {
    const std::wstring wide = to_wide(url);
    // Best effort: the URL is shown either way, for a member whose browser didn't open.
    ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

}

auto form_encoded(std::span<const form_field> fields) -> std::string {
    std::string form;
    for (const form_field& field : fields) {
        if (!form.empty()) {
            form.push_back('&');
        }
        form.append(percent_encoded(field.name)).append("=").append(percent_encoded(field.value));
    }
    return form;
}

auto request_id_of(std::string_view request_uri) -> std::optional<std::string> {
    if (!request_uri.starts_with(request_uri_prefix)) {
        return std::nullopt;
    }
    const std::string_view id = request_uri.substr(request_uri_prefix.size());
    constexpr std::string_view prefix = "lauth_";
    // platform/server/src/native/sign-in.ts: lauth_ and 22 base64url characters.
    if (!id.starts_with(prefix)
        || id.size() != prefix.size() + 22
        || !from_base64url(id.substr(prefix.size()))) {
        return std::nullopt;
    }
    return std::string{id};
}

auto sign_in(server& api, std::string_view web_origin, show_approval show)
    -> result<sign_in_outcome> {
    const callback_listener listener = LUCENT_TRY(callback_listener::open());
    const std::string redirect = listener.redirect_uri();
    const std::string verifier = random_token(verifier_bytes);
    const std::string challenge = to_base64url(sha256(as_bytes(verifier)));
    const std::string state = random_token(state_bytes);
    const std::array pushed_fields{
        form_field{.name = "client_id", .value = loader_client_id},
        form_field{.name = "response_type", .value = "code"},
        form_field{.name = "redirect_uri", .value = redirect},
        form_field{.name = "code_challenge", .value = challenge},
        form_field{.name = "code_challenge_method", .value = "S256"},
        form_field{.name = "state", .value = state},
    };
    const oauth_answer pushed =
        LUCENT_TRY(api.send_form("/v1/auth/requests", form_encoded(pushed_fields)));
    if (pushed.status != 201) {
        return oauth_refusal{
            .reason = string_member(pushed.body, "error").value_or("server_error"),
        };
    }
    const std::optional<std::string> request_id =
        request_id_of(string_member(pushed.body, "request_uri").value_or(""));
    if (!request_id) {
        return oauth_refusal{.reason = "server_error"};
    }
    const std::string url = std::format("{}/auth/device/{}", web_origin, *request_id);
    open_in_browser(url);
    show(url);
    // A callback carrying another state wasn't sent by this request's approval (RFC 6749 §10.12):
    // any local process can call the port, so such a callback is ignored and the wait goes on.
    const auto deadline = std::chrono::steady_clock::now() + longest_wait;
    std::optional<authorized> code;
    while (!code) {
        const auto left = std::chrono::duration_cast<std::chrono::seconds>(
            deadline - std::chrono::steady_clock::now()
        );
        if (left.count() <= 0) {
            return std::unexpected(error{.code = error_code::timed_out});
        }
        const callback_result came_back = LUCENT_TRY(listener.wait(left));
        if (state_of(came_back) != state) {
            continue;
        }
        code = granted_of(came_back);
        if (!code) {
            return oauth_refusal{.reason = "access_denied"};
        }
    }
    const std::array token_fields{
        form_field{.name = "client_id", .value = loader_client_id},
        form_field{.name = "grant_type", .value = "authorization_code"},
        form_field{.name = "code", .value = code->code},
        form_field{.name = "code_verifier", .value = verifier},
        form_field{.name = "redirect_uri", .value = redirect},
    };
    return tokens_of(LUCENT_TRY(api.send_form("/v1/auth/token", form_encoded(token_fields))));
}

auto refresh(server& api, std::string_view refresh_token) -> result<sign_in_outcome> {
    const std::array fields{
        form_field{.name = "client_id", .value = loader_client_id},
        form_field{.name = "grant_type", .value = "refresh_token"},
        form_field{.name = "refresh_token", .value = refresh_token},
    };
    return tokens_of(LUCENT_TRY(api.send_form("/v1/auth/token", form_encoded(fields))));
}

credentials::credentials(std::string refresh_token)
    : m_refresh_token{std::move(refresh_token)} {}

auto credentials::replace(const token_set& tokens) -> void {
    m_refresh_token = tokens.refresh_token;
    m_access_token = tokens.access_token;
    m_access_expires = std::chrono::steady_clock::now() + tokens.expires_in;
}

auto credentials::access_token(server& api, keeper keep) -> result<std::optional<std::string>> {
    if (!m_access_token.empty()
        && std::chrono::steady_clock::now() + refresh_margin < m_access_expires) {
        return m_access_token;
    }
    if (m_refresh_token.empty()) {
        return std::nullopt;
    }
    const sign_in_outcome refreshed = LUCENT_TRY(refresh(api, m_refresh_token));
    const std::optional<token_set> tokens = issued_of(refreshed);
    if (!tokens) {
        const std::string reason = match(
            refreshed,
            [](const token_set&) { return std::string{}; },
            [](const oauth_refusal& refused) { return refused.reason; }
        );
        // Only these say the token is spent (RFC 6749 §5.2); anything else (slow_down, a 503, a
        // proof refused after the clock retry) is the server's trouble, and the token stays for the
        // next try.
        if (reason != "invalid_grant" && reason != "invalid_client") {
            return std::unexpected(error{.code = error_code::unsupported});
        }
        m_refresh_token.clear();
        m_access_token.clear();
        LUCENT_TRY(keep(""));
        return std::nullopt;
    }
    // In memory first: the server has rotated already, so the old token is spent whatever the save
    // does, and a failed save must not leave the old one in use.
    replace(*tokens);
    LUCENT_TRY(keep(tokens->refresh_token));
    return m_access_token;
}

}
