#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>
#include <lucent/fuzzing/run_one.hpp>

#include "lucent/draw/rect.hpp"

// draw::check over frames built from arbitrary bytes: the backend trusts whatever it accepts, so
// an accepted frame must index inside its buffers and balance its layers, and nothing it is given
// may crash it. Seed with any bytes; a few hundred random ones reach every command kind.

namespace lucent::fuzzing {
namespace {

// Reads values off the front of the input; past its end every read is zero.
class byte_reader final {
public:
    explicit byte_reader(std::span<const std::byte> input)
        : m_rest{input} {}

    template <typename T>
        requires std::is_trivially_copyable_v<T>
    auto read() -> T {
        std::array<std::byte, sizeof(T)> bytes{};
        const usize taken = std::min(bytes.size(), m_rest.size());
        std::ranges::copy(m_rest.first(taken), bytes.begin());
        m_rest = m_rest.subspan(taken);
        return std::bit_cast<T>(bytes);
    }

private:
    std::span<const std::byte> m_rest;
};

auto clip_of(byte_reader& bytes) -> draw::pixel_rect {
    return {
        .left = bytes.read<i16>(),
        .top = bytes.read<i16>(),
        .right = bytes.read<i16>(),
        .bottom = bytes.read<i16>(),
    };
}

auto command_of(byte_reader& bytes) -> draw::command {
    switch (bytes.read<u8>() % 4U) {
    case 0: {
        const draw::pixel_rect clip = clip_of(bytes);
        const isize first = bytes.read<u16>();
        const isize count = bytes.read<u16>();
        const bool has_image = (bytes.read<u8>() & 1U) != 0;
        const u64 image = bytes.read<u64>();
        return draw::quad_run{
            .clip = clip,
            .first = first,
            .count = count,
            .image = has_image ? std::optional{draw::image_handle{image}} : std::nullopt,
        };
    }
    case 1: {
        const draw::pixel_rect clip = clip_of(bytes);
        const isize first = bytes.read<u16>();
        const isize count = bytes.read<u16>();
        return draw::path_run{.clip = clip, .first = first, .count = count};
    }
    case 2: {
        const draw::rect bounds{
            .min = {.x = bytes.read<f32>(), .y = bytes.read<f32>()},
            .max = {.x = bytes.read<f32>(), .y = bytes.read<f32>()},
        };
        const draw::layer surface{
            .bounds = bounds,
            .radius = bytes.read<f32>(),
            .opacity = bytes.read<f32>(),
            .blur = bytes.read<f32>(),
            .rim = bytes.read<f32>(),
            .light = std::nullopt,
        };
        return draw::layer_begin{.surface = surface, .clip = clip_of(bytes)};
    }
    default:
        return draw::layer_end{};
    }
}

auto is_inside(isize first, isize count, isize size) -> bool {
    return first >= 0 && count >= 0 && first + count <= size;
}

// What the backend relies on of an accepted frame, checked apart from check() itself.
auto holds(const draw::frame_data& frame) -> void {
    isize depth = 0;
    for (const draw::command& next : frame.commands) {
        match(
            next,
            [&](const draw::quad_run& run) {
                LUCENT_INVARIANT(is_inside(run.first, run.count, std::ssize(frame.records)));
            },
            [&](const draw::path_run& run) {
                LUCENT_INVARIANT(is_inside(run.first, run.count, std::ssize(frame.path_vertices)));
            },
            [&](const draw::layer_begin&) { ++depth; },
            [&](const draw::layer_end&) {
                --depth;
                LUCENT_INVARIANT(depth >= 0);
            }
        );
    }
    LUCENT_INVARIANT(depth == 0);
}

}

auto run_one(std::span<const std::byte> input) -> void {
    byte_reader bytes{input};
    const draw::pixel_size target{.width = bytes.read<u16>(), .height = bytes.read<u16>()};
    std::vector<draw::quad_record> records(bytes.read<u8>());
    for (draw::quad_record& record : records) {
        record = bytes.read<draw::quad_record>();
    }
    std::vector<draw::path_vertex> vertices(bytes.read<u8>());
    for (draw::path_vertex& vertex : vertices) {
        vertex = bytes.read<draw::path_vertex>();
    }
    std::vector<draw::command> commands(bytes.read<u8>() % 32U);
    for (draw::command& next : commands) {
        next = command_of(bytes);
    }
    const draw::frame_data frame{
        .target = target,
        .records = records,
        .path_vertices = vertices,
        .commands = commands,
    };
    if (draw::check(frame)) {
        holds(frame);
    }
}

}
