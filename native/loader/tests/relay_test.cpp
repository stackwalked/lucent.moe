#include "session/relay.hpp"

#include <array>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/session_message.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>

#include "api/server.hpp"

// The relay against a server written here: what the platform would answer, recorded calls.

namespace lucent::loader {
namespace {

auto id_of(u8 fill) -> wire::session_id {
    wire::session_id session;
    session.bytes.fill(std::byte{fill});
    return session;
}

auto renewal_frame() -> wire::frame {
    return wire::frame{
        .header = {.session = id_of(3), .way = wire::direction::module_to_server, .sequence = 1},
        .nonce = {},
        .sealed = std::vector<std::byte>(16, std::byte{0xaa}),
    };
}

auto lease_frame() -> wire::frame {
    return wire::frame{
        .header = {.session = id_of(3), .way = wire::direction::server_to_module, .sequence = 1},
        .nonce = {},
        .sealed = std::vector<std::byte>(16, std::byte{0xbb}),
    };
}

auto session_reply_bytes() -> std::vector<std::byte> {
    return wire::encode_session_reply(
        wire::session_reply{
            .exchange =
                wire::session_exchange{
                    .session = id_of(3),
                    .module_key = {},
                    .nonce = {},
                    .server_key = {},
                    .signature = {},
                },
            .first_lease = lease_frame(),
        }
    );
}

// A code no build of this loader knows, as the server would send it: the code byte follows the
// refusal's 32-byte context (contracts/wire/v1/refusal_unknown.bin carries 200 there).
auto unknown_code() -> wire::refusal_code {
    std::vector<std::byte> bytes = wire::encode_refusal(
        wire::refusal{.code = wire::refusal_code::service_unavailable, .retry_after = {}}
    );
    bytes.at(32) = std::byte{200};
    const result<wire::refusal> decoded = wire::decode_refusal(bytes);
    REQUIRE(decoded.has_value());
    return decoded->code;
}

auto refusal(wire::refusal_code code) -> answer {
    return answer{wire::refusal{.code = code, .retry_after = {}}};
}

// Answers each call from what the test set, and records what it was sent.
class scripted_server final : public server_link {
public:
    std::optional<result<answer>> hello_answer;
    std::optional<result<answer>> renewal_answer;
    std::vector<std::vector<std::byte>> renewals_sent;
    i32 hellos_sent = 0;

    auto open_session(const wire::start_id& /*start*/, std::span<const std::byte> /*hello*/)
        -> result<answer> override {
        ++hellos_sent;
        if (!hello_answer) {
            FAIL("the test set no hello answer");
            return std::unexpected(error{.code = error_code::closed});
        }
        return *hello_answer;
    }

    auto renew(const wire::session_id& session, std::span<const std::byte> request)
        -> result<answer> override {
        REQUIRE(session == id_of(3));
        renewals_sent.emplace_back(request.begin(), request.end());
        if (!renewal_answer) {
            FAIL("the test set no renewal answer");
            return std::unexpected(error{.code = error_code::closed});
        }
        return *renewal_answer;
    }

    auto close(const wire::session_id& /*session*/) -> result<void> override {
        return {};
    }
};

auto hello() -> kit::session_message {
    return kit::server_request{
        .route = kit::server_route::session,
        .body = std::vector<std::byte>(8),
    };
}

auto renewal() -> kit::session_message {
    return kit::server_request{
        .route = kit::server_route::lease,
        .body = wire::encode_frame(renewal_frame()),
    };
}

auto opened(relay& state, scripted_server& server) -> void {
    server.hello_answer = answer{session_reply_bytes()};
    const std::optional<kit::session_message> reply = state.on_message(hello(), server);
    REQUIRE(
        reply
        == kit::session_message{
            kit::server_reply{.route = kit::server_route::session, .body = session_reply_bytes()}
        }
    );
    REQUIRE(state.session() == id_of(3));
}

TEST_CASE("the server's session reply goes back to the module whole, and opens the session") {
    scripted_server server;
    relay state{wire::start_id{}};
    opened(state, server);
}

TEST_CASE("a refused hello unloads the module and keeps the reason") {
    scripted_server server;
    server.hello_answer = refusal(wire::refusal_code::slot_taken);
    relay state{wire::start_id{}};
    REQUIRE(state.on_message(hello(), server) == kit::session_message{kit::unload_request{}});
    REQUIRE(state.refused() == wire::refusal_code::slot_taken);
    REQUIRE_FALSE(state.session());
}

TEST_CASE("an unreachable server gets the module no reply, so its lease runs out on its own") {
    scripted_server server;
    server.hello_answer = result<answer>{std::unexpected(error{.code = error_code::system})};
    relay state{wire::start_id{}};
    REQUIRE_FALSE(state.on_message(hello(), server));
    REQUIRE_FALSE(state.refused());
}

TEST_CASE("a second hello isn't relayed: a start opens one session") {
    scripted_server server;
    relay state{wire::start_id{}};
    opened(state, server);
    REQUIRE_FALSE(state.on_message(hello(), server));
    REQUIRE(server.hellos_sent == 1);
}

TEST_CASE("a renewal before the session opened isn't relayed") {
    scripted_server server;
    relay state{wire::start_id{}};
    REQUIRE_FALSE(state.on_message(renewal(), server));
    REQUIRE(server.renewals_sent.empty());
}

TEST_CASE(
    "renewals carry the loader's answer once the server has challenged it, and return the lease "
    "frame alone"
) {
    scripted_server server;
    relay state{wire::start_id{}};
    opened(state, server);
    const wire::hash_challenge challenge{.nonce = {}, .offset = 0x1000, .size = 64};
    server.renewal_answer = answer{wire::encode_lease_response(
        wire::lease_response{.loader_challenge = challenge, .lease = lease_frame()}
    )};

    const std::optional<kit::session_message> first = state.on_message(renewal(), server);
    REQUIRE(
        first
        == kit::session_message{kit::server_reply{
            .route = kit::server_route::lease, .body = wire::encode_frame(lease_frame())
        }}
    );
    const result<wire::lease_request> first_sent =
        wire::decode_lease_request(server.renewals_sent.at(0));
    REQUIRE(first_sent);
    REQUIRE_FALSE(first_sent->loader_answer);
    REQUIRE(first_sent->renewal == renewal_frame());

    REQUIRE(state.on_message(renewal(), server));
    const result<wire::lease_request> second_sent =
        wire::decode_lease_request(server.renewals_sent.at(1));
    REQUIRE(second_sent);
    REQUIRE(second_sent->loader_answer == loader_challenge_answer(challenge));
}

TEST_CASE("a stale renewal, a troubled server or an unknown code leave the module on its lease") {
    for (const wire::refusal_code code : {
             wire::refusal_code::stale_sequence,
             wire::refusal_code::service_unavailable,
             wire::refusal_code::rate_limited,
             unknown_code(),
         }) {
        scripted_server server;
        relay state{wire::start_id{}};
        opened(state, server);
        server.renewal_answer = refusal(code);
        REQUIRE_FALSE(state.on_message(renewal(), server).has_value());
        REQUIRE_FALSE(state.refused().has_value());
    }
}

TEST_CASE("a troubled server's answer to the hello leaves the start to the module") {
    scripted_server server;
    server.hello_answer = refusal(wire::refusal_code::service_unavailable);
    relay state{wire::start_id{}};
    REQUIRE_FALSE(state.on_message(hello(), server).has_value());
    REQUIRE_FALSE(state.refused().has_value());
}

TEST_CASE("a definitive refusal of a renewal unloads the module") {
    scripted_server server;
    relay state{wire::start_id{}};
    opened(state, server);
    server.renewal_answer = refusal(wire::refusal_code::account_suspended);
    REQUIRE(state.on_message(renewal(), server) == kit::session_message{kit::unload_request{}});
    REQUIRE(state.refused() == wire::refusal_code::account_suspended);
}

TEST_CASE("the module's own refusal is kept, and the first reason wins") {
    scripted_server server;
    relay state{wire::start_id{}};
    REQUIRE_FALSE(state.on_message(
        kit::start_refused{.code = wire::refusal_code::game_build_unsupported}, server
    ));
    server.hello_answer = refusal(wire::refusal_code::slot_taken);
    std::ignore = state.on_message(hello(), server);
    REQUIRE(state.refused() == wire::refusal_code::game_build_unsupported);
}

}
}
