#include "session/live_link.hpp"

#include <chrono>
#include <cstddef>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>

#include "account/sign_in.hpp"
#include "api/server.hpp"
#include "text/base64url.hpp"

namespace lucent::loader {
namespace {

// Every reply goes on to the module whole, so the pipe's bound is the body's: the session reply
// carries the first lease and data frames, a data reply a frame up to the wire's bound.
constexpr usize max_relayed_body = narrow<usize>(kit::max_frame_size);

// The relay is one thread: a data call waiting the client's 30 s, twice for a proof retried with
// the server's clock, would hold up the renewals behind it (every 15 s, the lease lasting 60 s)
// until the lease lapsed. The module asks again for a data reply that never came.
constexpr std::chrono::milliseconds data_receive_timeout{10'000};

}

live_link::live_link(server& api, credentials& tokens, credentials::keeper keep)
    : m_api{&api}
    , m_tokens{&tokens}
    , m_keep{keep} {}

auto live_link::post(
    std::string_view path,
    std::span<const std::byte> body,
    std::optional<std::chrono::milliseconds> receive_timeout
) -> result<answer> {
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
            .max_body = max_relayed_body,
            .receive_timeout = receive_timeout,
        }
    );
}

auto live_link::open_session(const wire::start_id& start, std::span<const std::byte> hello)
    -> result<answer> {
    return post(std::format("/v1/starts/{}/session", to_hex(start.bytes)), hello, std::nullopt);
}

auto live_link::renew(const wire::session_id& session, std::span<const std::byte> request)
    -> result<answer> {
    return post(std::format("/v1/sessions/{}/lease", to_hex(session.bytes)), request, std::nullopt);
}

auto live_link::fetch_data(const wire::session_id& session, std::span<const std::byte> frame)
    -> result<answer> {
    return post(
        std::format("/v1/sessions/{}/data", to_hex(session.bytes)), frame, data_receive_timeout
    );
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
