#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <variant>
#include <vector>

namespace lucent::kit {

enum class stage : u8 { boot, attach, run, detach, unload };

// The dev channel's message (lucent/kit/dev_channel.hpp): only dev builds send it, so a release
// module sends stages and nothing else.
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

using session_message = std::variant<dev_text, stage_reached, unload_request>;

// On the wire a message is a frame: a little-endian u32 size, then that many bytes holding a kind
// byte and the payload.
inline constexpr usize frame_header_size = 4;

// Bounds every read, so a corrupt size can't make the reader allocate gigabytes.
inline constexpr isize max_frame_size = isize{64} * 1024;

auto encode(const session_message& message) -> std::vector<std::byte>;

// The size of the frame body that follows this header.
auto decode_frame_size(std::span<const std::byte, frame_header_size> header) -> result<isize>;

auto decode(std::span<const std::byte> body) -> result<session_message>;

}
