#include <lucent/kit/session_message.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/wire/refusal.hpp>

namespace lucent::kit {
namespace {

static_assert(std::endian::native == std::endian::little, "the wire is little-endian, as is x64");

// The kind byte. Part of the wire format: a change bumps boot_info_version.
enum class message_kind : u8 {
    dev_text = 1,
    stage_reached = 2,
    unload_request = 3,
    start_refused = 4,
    server_request = 5,
    server_reply = 6,
};

constexpr error malformed{.code = error_code::malformed};

auto frame(message_kind kind, std::span<const std::byte> payload) -> std::vector<std::byte> {
    const auto body_size = narrow<u32>(std::ssize(payload) + 1);
    const auto header = std::bit_cast<std::array<std::byte, frame_header_size>>(body_size);
    std::vector<std::byte> bytes{header.begin(), header.end()};
    bytes.push_back(static_cast<std::byte>(std::to_underlying(kind)));
    bytes.insert(bytes.end(), payload.begin(), payload.end());
    return bytes;
}

auto frame_of(const dev_text& line) -> std::vector<std::byte> {
    return frame(message_kind::dev_text, std::as_bytes(std::span{line.text}));
}

auto frame_of(const stage_reached& reached) -> std::vector<std::byte> {
    const std::array payload{static_cast<std::byte>(std::to_underlying(reached.reached))};
    return frame(message_kind::stage_reached, payload);
}

auto frame_of([[maybe_unused]] const unload_request& request) -> std::vector<std::byte> {
    return frame(message_kind::unload_request, {});
}

auto frame_of(const start_refused& refused) -> std::vector<std::byte> {
    const std::array payload{static_cast<std::byte>(std::to_underlying(refused.code))};
    return frame(message_kind::start_refused, payload);
}

// A route byte, then the body.
auto relayed(message_kind kind, server_route route, std::span<const std::byte> body)
    -> std::vector<std::byte> {
    std::vector<std::byte> payload{static_cast<std::byte>(std::to_underlying(route))};
    payload.insert(payload.end(), body.begin(), body.end());
    return frame(kind, payload);
}

auto frame_of(const server_request& request) -> std::vector<std::byte> {
    return relayed(message_kind::server_request, request.route, request.body);
}

auto frame_of(const server_reply& reply) -> std::vector<std::byte> {
    return relayed(message_kind::server_reply, reply.route, reply.body);
}

auto to_char(std::byte byte) -> char {
    return std::to_integer<char>(byte);
}

auto decode_stage(std::span<const std::byte> payload) -> result<session_message> {
    if (payload.size() != 1) {
        return std::unexpected(malformed);
    }
    const auto raw = std::to_integer<u8>(payload.front());
    if (raw > std::to_underlying(stage::unload)) {
        return std::unexpected(malformed);
    }
    return stage_reached{.reached = static_cast<stage>(raw)};
}

struct relayed_body {
    server_route route = server_route::session;
    std::vector<std::byte> body;
};

// Every relayed message carries a body: an empty one is no call the server knows.
auto decode_relayed(std::span<const std::byte> payload) -> result<relayed_body> {
    if (payload.size() < 2) {
        return std::unexpected(malformed);
    }
    const auto raw = std::to_integer<u8>(payload.front());
    if (raw != std::to_underlying(server_route::session)
        && raw != std::to_underlying(server_route::lease)) {
        return std::unexpected(malformed);
    }
    const std::span<const std::byte> body = payload.subspan(1);
    return relayed_body{
        .route = static_cast<server_route>(raw),
        .body = std::vector<std::byte>{body.begin(), body.end()},
    };
}

// A code this build doesn't know still decodes, as a refusal's does: the host shows it as a
// generic refusal. 0 is no code.
auto decode_start_refused(std::span<const std::byte> payload) -> result<session_message> {
    if (payload.size() != 1 || std::to_integer<u8>(payload.front()) == 0) {
        return std::unexpected(malformed);
    }
    const auto code = static_cast<wire::refusal_code>(std::to_integer<u8>(payload.front()));
    return start_refused{.code = code};
}

}

auto is_unload_request(const session_message& message) -> bool {
    return match(
        message,
        [](const dev_text&) { return false; },
        [](const stage_reached&) { return false; },
        [](const unload_request&) { return true; },
        [](const start_refused&) { return false; },
        [](const server_request&) { return false; },
        [](const server_reply&) { return false; }
    );
}

auto reply_body(const session_message& message, server_route route)
    -> std::optional<std::vector<std::byte>> {
    const auto none = [](const auto&) -> std::optional<std::vector<std::byte>> {
        return std::nullopt;
    };
    return match(
        message,
        [route](const server_reply& reply) -> std::optional<std::vector<std::byte>> {
            if (reply.route != route) {
                return std::nullopt;
            }
            return reply.body;
        },
        [none](const dev_text& other) { return none(other); },
        [none](const stage_reached& other) { return none(other); },
        [none](const unload_request& other) { return none(other); },
        [none](const start_refused& other) { return none(other); },
        [none](const server_request& other) { return none(other); }
    );
}

auto encode(const session_message& message) -> std::vector<std::byte> {
    return match(
        message,
        [](const dev_text& line) { return frame_of(line); },
        [](const stage_reached& reached) { return frame_of(reached); },
        [](const unload_request& request) { return frame_of(request); },
        [](const start_refused& refused) { return frame_of(refused); },
        [](const server_request& request) { return frame_of(request); },
        [](const server_reply& reply) { return frame_of(reply); }
    );
}

auto decode_frame_size(std::span<const std::byte, frame_header_size> header) -> result<isize> {
    std::array<std::byte, frame_header_size> raw{};
    std::ranges::copy(header, raw.begin());
    const auto size = static_cast<isize>(std::bit_cast<u32>(raw));
    if (size == 0 || size > max_frame_size) {
        return std::unexpected(malformed);
    }
    return size;
}

auto decode(std::span<const std::byte> body) -> result<session_message> {
    if (body.empty()) {
        return std::unexpected(malformed);
    }
    const std::span<const std::byte> payload = body.subspan(1);
    switch (static_cast<message_kind>(std::to_integer<u8>(body.front()))) {
    case message_kind::dev_text:
        return dev_text{
            .text = payload | std::views::transform(to_char) | std::ranges::to<std::string>(),
        };
    case message_kind::stage_reached:
        return decode_stage(payload);
    case message_kind::unload_request:
        if (!payload.empty()) {
            return std::unexpected(malformed);
        }
        return unload_request{};
    case message_kind::start_refused:
        return decode_start_refused(payload);
    case message_kind::server_request: {
        relayed_body relayed = LUCENT_TRY(decode_relayed(payload));
        return server_request{.route = relayed.route, .body = std::move(relayed.body)};
    }
    case message_kind::server_reply: {
        relayed_body relayed = LUCENT_TRY(decode_relayed(payload));
        return server_reply{.route = relayed.route, .body = std::move(relayed.body)};
    }
    }
    // The kind byte came from outside: anything not listed above is malformed, not a bug of ours.
    return std::unexpected(malformed);
}

}
