#pragma once

#include <memory>
#include <optional>
#include <span>
#include <vector>

#include <lucent/draw/arc.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/segment.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/draw/stroke_style.hpp>

namespace lucent::draw {

namespace detail {
class path_builder;
}

// What a list draws onto: the target's size, and how many pixels one unit of the list's input is.
// A layout written in units keeps one set of measures on any display.
struct list_target {
    pixel_size size;
    f32 pixels_per_unit = 1.0F;
};

// Records one frame of drawing for a backend: a value with no globals, recorded by one thread at a
// time. Input is in units; every axis-aligned edge (rects, clips, images, translations, a glyph
// run's origin) lands on a whole pixel, so what meets in units meets on screen. A stroke one unit
// wide or less, and a rect one unit thin or less, takes whole pixels (at least one), so a hairline
// is one thickness wherever it lands. Curves keep their exact positions.
//
// Exceeding a limit, or popping what wasn't pushed, is a bug in the caller: an invariant.
class draw_list final {
public:
    static constexpr isize max_records = isize{u32{1} << 16U};
    static constexpr isize max_path_vertices = isize{u32{1} << 18U};
    static constexpr isize max_commands = isize{u32{1} << 14U};
    static constexpr isize max_clip_depth = 32;
    static constexpr isize max_translation_depth = 32;
    static constexpr isize max_layer_depth = 8;
    // Points a single fill_convex, fill_polygon or path stroke takes.
    static constexpr isize max_path_points = 1024;
    // A layer's backdrop blur, in pixels: the most the backend sizes its passes for.
    static constexpr f32 max_layer_blur = 128.0F;

    draw_list();
    ~draw_list();
    draw_list(const draw_list&) = delete (
        "a frame is recorded again, not copied; the path scratch is per recorder"
    );
    auto operator=(const draw_list&)
        -> draw_list& = delete ("a frame is recorded again, not copied");
    draw_list(draw_list&& other) noexcept;
    auto operator=(draw_list&& other) noexcept -> draw_list&;

    // Starts a frame with the whole target as the clip. Capacity is kept, so a list reused every
    // frame stops allocating once it has seen its largest frame.
    auto reset(list_target target) -> void;

    auto push_clip(const rect& area) -> void;
    auto pop_clip() -> void;
    // Moves everything drawn inside, clips and layers included. Snapped to whole pixels as pushed.
    auto push_translation(vec2 offset) -> void;
    auto pop_translation() -> void;
    // Its contents are clipped to the layer's bounds.
    auto push_layer(const layer& surface) -> void;
    auto pop_layer() -> void;

    auto fill(const rounded_rect& shape, const paint& with) -> void;
    auto fill(const circle& shape, const paint& with) -> void;
    auto stroke(const rounded_rect& shape, const paint& with, const stroke_style& style) -> void;
    auto stroke(const circle& shape, const paint& with, const stroke_style& style) -> void;
    auto stroke(const arc& shape, const paint& with, const stroke_style& style) -> void;
    auto stroke(const segment& shape, const paint& with, const stroke_style& style) -> void;
    auto shadow(const rounded_rect& shape, const shadow_style& style) -> void;

    // Tessellated, solid colour only. A polygon may be concave or touch itself. Paths are curves:
    // they keep their exact positions and widths.
    auto fill_convex(std::span<const vec2> outline, color tint) -> void;
    auto fill_polygon(std::span<const vec2> outline, color tint) -> void;
    auto stroke(const path_stroke& path) -> void;

    auto draw(const image_quad& quad) -> void;
    auto draw(const glyph_run& run) -> void;

    // Valid until the list records again. Every push must have been popped.
    auto frame() const -> frame_data;
    // What reset() set: text laid out at another scale doesn't draw on this list.
    auto pixels_per_unit() const -> f32;

private:
    auto add_record(const quad_record& record, std::optional<image_handle> image) -> void;
    auto add_path(std::span<const path_vertex> vertices) -> void;
    auto to_pixels(vec2 point) const -> vec2;
    auto snapped(const rect& box) const -> rect;
    auto stroke_width(f32 width) const -> f32;
    auto in_pixels(const paint& with) const -> paint;
    auto points_in_pixels(std::span<const vec2> points) -> std::span<const vec2>;
    auto clip() const -> const pixel_rect&;

    pixel_size m_target;
    f32 m_scale = 1.0F;
    std::vector<quad_record> m_records;
    std::vector<path_vertex> m_path_vertices;
    std::vector<command> m_commands;
    std::vector<pixel_rect> m_clips;
    std::vector<vec2> m_translations;
    // The clip depth each open layer pushed its own clip at, so pop_layer can tell it pops a layer.
    std::vector<isize> m_layers;
    std::vector<vec2> m_scratch_points;
    std::unique_ptr<detail::path_builder> m_paths;
};

}
