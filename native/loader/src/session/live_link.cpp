#include "session/live_link.hpp"

#include <cstddef>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>

#include "account/sign_in.hpp"
#include "api/server.hpp"
#include "text/base64url.hpp"

namespace lucent::loader {

live_link::live_link(server& api, credentials& tokens, credentials::keeper keep)
    : m_api{&api}
    , m_tokens{&tokens}
    , m_keep{keep} {}

auto live_link::post(std::string_view path, std::span<const std::byte> body) -> result<answer> {
    const std::optional<std::string> token = LUCENT_TRY(m_tokens->access_token(*m_api, m_keep));
    if (!token) {
        return answer{wire::refusal{.code = wire::refusal_code::auth_required, .retry_after = {}}};
    }
    return m_api->send(
        call{
            .method = "POST",
            .path = path,
            .access_token = *token,
            .body = body,
            .kind = operation::fresh,
        }
    );
}

auto live_link::open_session(const wire::start_id& start, std::span<const std::byte> hello)
    -> result<answer> {
    return post(std::format("/v1/starts/{}/session", to_hex(start.bytes)), hello);
}

auto live_link::renew(const wire::session_id& session, std::span<const std::byte> request)
    -> result<answer> {
    return post(std::format("/v1/sessions/{}/lease", to_hex(session.bytes)), request);
}

auto live_link::fetch_data(const wire::session_id& session, std::span<const std::byte> frame)
    -> result<answer> {
    return post(std::format("/v1/sessions/{}/data", to_hex(session.bytes)), frame);
}

auto live_link::close(const wire::session_id& session) -> result<void> {
    const std::optional<std::string> token = LUCENT_TRY(m_tokens->access_token(*m_api, m_keep));
    if (!token) {
        return {};
    }
    const std::string path = std::format("/v1/sessions/{}/close", to_hex(session.bytes));
    // A close that doesn't arrive costs the slot until the last lease expires, nothing more.
    LUCENT_TRY(m_api->send(
        call{
            .method = "POST",
            .path = path,
            .access_token = *token,
            .body = {},
            .kind = operation::none
        }
    ));
    return {};
}

}
