#include <lucent/draw/frame_data.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <expected>
#include <span>
#include <utility>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/half.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>

#include "lucent/draw/glyph_run.hpp"

namespace lucent::draw {
namespace {

constexpr error malformed{.code = error_code::malformed};
// A D3D11 render target's largest side (D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION).
constexpr i32 max_target_side = 16'384;

auto is_finite(std::span<const f32> values) -> bool {
    return std::ranges::all_of(values, [](f32 value) { return std::isfinite(value); });
}

auto is_inside(const pixel_rect& clip, pixel_size target) -> bool {
    return clip.left >= 0
           && clip.top >= 0
           && clip.left <= clip.right
           && clip.top <= clip.bottom
           && clip.right <= target.width
           && clip.bottom <= target.height;
}

auto is_in_range(isize first, isize count, isize size) -> bool {
    return first >= 0 && count > 0 && count <= size && first <= size - count;
}

// Softness and stroke width: finite and not negative (a clear sign bit; -0 never occurs).
auto is_length(u16 half) -> bool {
    return is_finite_half(half) && (half & 0x8000U) == 0;
}

// An atlas record names a page the texture array has.
auto is_valid_page(const quad_record& record) -> bool {
    const auto kinds = unpack_kinds(record.style[2]);
    return kinds.has_value()
           && (kinds->quad != quad_kind::atlas
               || std::to_underlying(kinds->page) < atlas_page_count);
}

auto is_valid(const quad_record& record) -> bool {
    const u16 softness = narrow<u16>(record.style[3] & 0xffffU);
    const u16 stroke = narrow<u16>(record.style[3] >> 16U);
    return is_finite(record.rect)
           && is_finite(record.geometry)
           && is_finite(record.gradient)
           && unpack_kinds(record.style[2]).has_value()
           && is_length(softness)
           && is_length(stroke)
           && is_valid_page(record);
}

auto is_image(const quad_record& record) -> bool {
    const auto kinds = unpack_kinds(record.style[2]);
    return kinds.has_value() && kinds->quad == quad_kind::image;
}

auto is_valid(const layer& surface) -> bool {
    const std::array<f32, 8> values{
        surface.bounds.min.x,
        surface.bounds.min.y,
        surface.bounds.max.x,
        surface.bounds.max.y,
        surface.radius,
        surface.opacity,
        surface.blur,
        surface.rim,
    };
    // The ranges the list records: the backend sizes its blur passes by these, so a hand-built
    // frame can't ask for an unbounded kernel or a rim with no blurred backdrop to bend.
    return is_finite(values)
           && surface.radius >= 0.0F
           && surface.opacity >= 0.0F
           && surface.opacity <= 1.0F
           && surface.blur >= 0.0F
           && surface.blur <= draw_list::max_layer_blur
           && surface.rim >= 0.0F
           && (surface.rim <= 0.0F || surface.blur > 0.0F)
           && (!surface.light.has_value() || surface.blur > 0.0F);
}

// Walks the commands in order, keeping the layer depth.
class command_checker final {
public:
    explicit command_checker(frame_data frame)
        : m_frame{frame} {}

    auto accepts(const command& next) -> bool {
        return match(
            next,
            [this](const quad_run& run) { return accepts_quads(run); },
            [this](const path_run& run) { return accepts_paths(run); },
            [this](const layer_begin& begin) { return open_layer(begin); },
            [this](const layer_end&) { return close_layer(); }
        );
    }

    auto is_balanced() const -> bool {
        return m_depth == 0;
    }

private:
    auto accepts_quads(const quad_run& run) const -> bool {
        if (!is_inside(run.clip, m_frame.target)
            || !is_in_range(run.first, run.count, std::ssize(m_frame.records))) {
            return false;
        }
        const auto covered =
            m_frame.records.subspan(narrow<usize>(run.first), narrow<usize>(run.count));
        return std::ranges::all_of(covered, [&run](const quad_record& record) {
            return is_valid(record) && (run.image.has_value() || !is_image(record));
        });
    }

    auto accepts_paths(const path_run& run) const -> bool {
        if (!is_inside(run.clip, m_frame.target)
            || !is_in_range(run.first, run.count, std::ssize(m_frame.path_vertices))
            || run.count % 3 != 0) {
            return false;
        }
        const auto covered =
            m_frame.path_vertices.subspan(narrow<usize>(run.first), narrow<usize>(run.count));
        return std::ranges::all_of(covered, [](const path_vertex& vertex) {
            return std::isfinite(vertex.position.x) && std::isfinite(vertex.position.y);
        });
    }

    auto open_layer(const layer_begin& begin) -> bool {
        m_depth += 1;
        return m_depth <= draw_list::max_layer_depth
               && is_inside(begin.clip, m_frame.target)
               && is_valid(begin.surface);
    }

    auto close_layer() -> bool {
        m_depth -= 1;
        return m_depth >= 0;
    }

    frame_data m_frame;
    isize m_depth = 0;
};

}

auto check(const frame_data& frame) -> result<void> {
    const bool has_valid_target = frame.target.width > 0
                                  && frame.target.height > 0
                                  && frame.target.width <= max_target_side
                                  && frame.target.height <= max_target_side;
    const bool is_within_limits = std::ssize(frame.records) <= draw_list::max_records
                                  && std::ssize(frame.path_vertices) <= draw_list::max_path_vertices
                                  && std::ssize(frame.commands) <= draw_list::max_commands;
    if (!has_valid_target || !is_within_limits) {
        return std::unexpected(malformed);
    }
    command_checker checker{frame};
    const bool has_valid_commands = std::ranges::all_of(
        frame.commands, [&checker](const command& next) { return checker.accepts(next); }
    );
    if (!has_valid_commands || !checker.is_balanced()) {
        return std::unexpected(malformed);
    }
    return {};
}

}
