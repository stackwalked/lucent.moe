#pragma once

#include <cstddef>
#include <span>

#include <lucent/wire/ids.hpp>

#include "account/sign_in.hpp"
#include "api/server.hpp"
#include "session/relay.hpp"

namespace lucent::loader {

// The relay's calls on the real server, each under a fresh access token: a session outlives many.
class live_link final : public server_link {
public:
    // All three are borrowed for the link's lifetime.
    live_link(server& api, credentials& tokens, credentials::keeper keep);

    auto open_session(const wire::start_id& start, std::span<const std::byte> hello)
        -> result<answer> override;
    auto renew(const wire::session_id& session, std::span<const std::byte> request)
        -> result<answer> override;
    auto close(const wire::session_id& session) -> result<void> override;

private:
    auto post(std::string_view path, std::span<const std::byte> body) -> result<answer>;

    server* m_api;
    credentials* m_tokens;
    credentials::keeper m_keep;
};

}
