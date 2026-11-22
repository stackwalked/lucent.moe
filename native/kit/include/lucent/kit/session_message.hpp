#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <variant>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/refusal.hpp>

namespace lucent::kit {

enum class stage : u8 { boot, attach, run, detach, unload };

// The dev channel's message (lucent/kit/dev_channel.hpp): only dev builds send it, so a release
// module sends stages and refusals and nothing else.
struct dev_text {
    std::string text;

    auto operator==(const dev_text&) const -> bool = default;
};

struct stage_reached {
    stage reached = stage::boot;

    auto operator==(const stage_reached&) const -> bool = default;
};

struct unload_request {
    auto operator==(const unload_request&) const -> bool = default;
};

// Why the module won't run, for the host to show: sent at most once, before the detach stage, when
// the start is refused, a core capability that waited for its module fails once it loads, or the
// lease ran out without a renewal (SESSION_ENDED). A code
// from the user-facing catalog, never a capability's name; dev builds say which over the dev
// channel.
struct start_refused {
    wire::refusal_code code = wire::refusal_code::service_unavailable;

    auto operator==(const start_refused&) const -> bool = default;
};

// Which /v1 call a relayed body belongs to. The host knows the rest: the start or session it
// opened, its DPoP, its own part of each lease exchange.
enum class server_route : u8 {
    // POST /v1/starts/:id/session: the body is the module's hello; the reply is the server's
    // session_reply.
    session = 1,
    // POST /v1/sessions/:id/lease: the body is the module's renewal frame; the reply is the
    // lease_response's frame alone, the host keeping its own challenge.
    lease = 2,
    // POST /v1/sessions/:id/data: the body is the module's data-route frame; the reply is the
    // server's data-route frame.
    data = 3,
};

// Module to host: send this body to the server. The host relays it unread and answers with a
// server_reply on the same route, or says nothing when the server couldn't be reached; a refusal
// it shows itself and unloads the module.
struct server_request {
    server_route route = server_route::session;
    std::vector<std::byte> body;

    auto operator==(const server_request&) const -> bool = default;
};

// Host to module: the server's answer to a server_request on that route.
struct server_reply {
    server_route route = server_route::session;
    std::vector<std::byte> body;

    auto operator==(const server_reply&) const -> bool = default;
};

using session_message = std::
    variant<dev_text, stage_reached, unload_request, start_refused, server_request, server_reply>;

// On the wire a message is a frame: a little-endian u32 size, then that many bytes holding a kind
// byte and the payload.
inline constexpr usize frame_header_size = 4;

// A wire frame at its largest (lucent/wire/frame.hpp, version 1): the plaintext bound, then the
// header (a 32-byte context, the session id, the direction byte and the u64 sequence), the nonce
// and the tag.
inline constexpr isize max_wire_frame_size = narrow<isize>(
    wire::max_frame_plain_size + 32 + wire::id_size + sizeof(u8) + sizeof(u64)
    + crypto::aead_nonce_size + crypto::aead_tag_size
);

// Bounds every read, so a corrupt size can't make the reader allocate gigabytes. The largest
// message is a relayed session reply: two wire frames (the first lease and the first data) after
// the kind byte, the route byte, the reply's context, the signed exchange and the lease frame's
// size, which the headroom holds with room to spare.
inline constexpr isize max_frame_size = (2 * max_wire_frame_size) + (isize{4} * 1024);

auto is_unload_request(const session_message& message) -> bool;

// The body of a server_reply on that route; nothing for any other message.
auto reply_body(const session_message& message, server_route route)
    -> std::optional<std::vector<std::byte>>;

auto encode(const session_message& message) -> std::vector<std::byte>;

// The size of the frame body that follows this header.
auto decode_frame_size(std::span<const std::byte, frame_header_size> header) -> result<isize>;

auto decode(std::span<const std::byte> body) -> result<session_message>;

}
