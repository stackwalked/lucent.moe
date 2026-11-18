#include <lucent/draw/draw_list.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <numbers>
#include <optional>
#include <span>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/arc.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/half.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/segment.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/draw/stroke_style.hpp>
#include <lucent/draw/vec2.hpp>

#include "path_builder.hpp"

namespace lucent::draw {
namespace {

// Far past any real target, and well inside the range where an f32 holds every integer, so a
// snapped coordinate converts to i32 exactly.
constexpr f32 coordinate_limit = f32{u32{1} << 24U};

// Half up, never away from zero: snap(x + k) == snap(x) + k for every whole k, so a shape keeps its
// pixel size as it scrolls across zero. std::round sends -0.5 and 0.5 apart.
auto snap(f32 value) -> f32 {
    return std::floor(value + 0.5F);
}

// An angle in [-pi, pi], so a gauge whose start keeps growing doesn't hand the shader a huge
// argument.
auto wrapped(f32 angle) -> f32 {
    return std::remainder(angle, 2.0F * std::numbers::pi_v<f32>);
}

// Where a band half_width either side of coordinate puts its edges on whole pixels, when its width
// is whole.
auto aligned(f32 coordinate, f32 half_width) -> f32 {
    return snap(coordinate - half_width) + half_width;
}

auto bounds_of(std::span<const path_vertex> vertices) -> rect {
    rect bounds{.min = vertices.front().position, .max = vertices.front().position};
    for (const path_vertex& vertex : vertices) {
        bounds.min = {
            .x = std::min(bounds.min.x, vertex.position.x),
            .y = std::min(bounds.min.y, vertex.position.y),
        };
        bounds.max = {
            .x = std::max(bounds.max.x, vertex.position.x),
            .y = std::max(bounds.max.y, vertex.position.y),
        };
    }
    return bounds;
}

static_assert(
    draw_list::max_path_points == detail::max_path_points,
    "the tessellator enforces the limit draw_list states"
);

auto to_pixel(f32 value) -> i32 {
    // A NaN edge would make the conversion undefined; zero collapses the clip it belongs to.
    if (std::isnan(value)) {
        return 0;
    }
    return static_cast<i32>(std::clamp(snap(value), -coordinate_limit, coordinate_limit));
}

auto to_pixel_rect(const rect& box) -> pixel_rect {
    return {
        .left = to_pixel(box.min.x),
        .top = to_pixel(box.min.y),
        .right = to_pixel(box.max.x),
        .bottom = to_pixel(box.max.y),
    };
}

auto intersect(const pixel_rect& left, const pixel_rect& right) -> pixel_rect {
    const pixel_rect overlap{
        .left = std::max(left.left, right.left),
        .top = std::max(left.top, right.top),
        .right = std::min(left.right, right.right),
        .bottom = std::min(left.bottom, right.bottom),
    };
    // An empty overlap keeps its corner, so it stays inside both and compares equal to itself.
    return {
        .left = overlap.left,
        .top = overlap.top,
        .right = std::max(overlap.left, overlap.right),
        .bottom = std::max(overlap.top, overlap.bottom),
    };
}

auto is_outside(const rect& reached, const pixel_rect& clip) -> bool {
    return clip.left >= clip.right
           || clip.top >= clip.bottom
           || reached.max.x <= static_cast<f32>(clip.left)
           || reached.max.y <= static_cast<f32>(clip.top)
           || reached.min.x >= static_cast<f32>(clip.right)
           || reached.min.y >= static_cast<f32>(clip.bottom);
}

auto grown(const rect& box, f32 amount) -> rect {
    return {
        .min = {.x = box.min.x - amount, .y = box.min.y - amount},
        .max = {.x = box.max.x + amount, .y = box.max.y + amount},
    };
}

auto as_array(const rect& box) -> std::array<f32, 4> {
    return {box.min.x, box.min.y, box.max.x, box.max.y};
}

auto from_array(const std::array<f32, 4>& values) -> rect {
    return {
        .min = {.x = values[0], .y = values[1]},
        .max = {.x = values[2], .y = values[3]},
    };
}

auto clamped(const corners& radii, const rect& box) -> std::array<f32, 4> {
    const f32 limit = std::max(0.0F, std::min(box.max.x - box.min.x, box.max.y - box.min.y) * 0.5F);
    const auto fit = [limit](f32 radius) { return std::clamp(radius, 0.0F, limit); };
    return {
        fit(radii.top_left),
        fit(radii.top_right),
        fit(radii.bottom_right),
        fit(radii.bottom_left),
    };
}

auto scaled(const corners& radii, f32 factor) -> corners {
    return {
        .top_left = radii.top_left * factor,
        .top_right = radii.top_right * factor,
        .bottom_right = radii.bottom_right * factor,
        .bottom_left = radii.bottom_left * factor,
    };
}

// The style register: both colours, the kinds, and the two binary16 lengths.
struct style_parts {
    paint with;
    record_kinds kinds;
    f32 softness = 0.0F;
    f32 stroke = 0.0F;
};

auto style_of(const style_parts& parts) -> std::array<u32, 4> {
    const u32 lengths = u32{to_half(parts.softness)} | (u32{to_half(parts.stroke)} << 16U);
    return {packed(parts.with.from), packed(parts.with.to), pack(parts.kinds), lengths};
}

auto gradient_of(const paint& with) -> std::array<f32, 4> {
    if (with.kind != paint_kind::linear) {
        return {};
    }
    return {with.start.x, with.start.y, with.end.x, with.end.y};
}

auto circle_rect(vec2 centre, f32 radius) -> rect {
    return {
        .min = {.x = centre.x - radius, .y = centre.y - radius},
        .max = {.x = centre.x + radius, .y = centre.y + radius},
    };
}

// The last command, when it is a run a new record or path may join.
auto open_quad_run(std::vector<command>& commands) -> quad_run* {
    if (commands.empty()) {
        return nullptr;
    }
    return match(
        commands.back(),
        [](quad_run& run) -> quad_run* { return &run; },
        [](path_run&) -> quad_run* { return nullptr; },
        [](layer_begin&) -> quad_run* { return nullptr; },
        [](layer_end&) -> quad_run* { return nullptr; }
    );
}

auto open_path_run(std::vector<command>& commands) -> path_run* {
    if (commands.empty()) {
        return nullptr;
    }
    return match(
        commands.back(),
        [](quad_run&) -> path_run* { return nullptr; },
        [](path_run& run) -> path_run* { return &run; },
        [](layer_begin&) -> path_run* { return nullptr; },
        [](layer_end&) -> path_run* { return nullptr; }
    );
}

}

draw_list::draw_list()
    : m_paths{std::make_unique<detail::path_builder>()} {
    reset({.size = {.width = 0, .height = 0}, .pixels_per_unit = 1.0F});
}

draw_list::~draw_list() = default;
draw_list::draw_list(draw_list&& other) noexcept = default;
auto draw_list::operator=(draw_list&& other) noexcept -> draw_list& = default;

auto draw_list::reset(list_target target) -> void {
    LUCENT_INVARIANT(target.size.width >= 0 && target.size.height >= 0);
    LUCENT_INVARIANT(std::isfinite(target.pixels_per_unit) && target.pixels_per_unit > 0.0F);
    m_target = target.size;
    m_scale = target.pixels_per_unit;
    m_records.clear();
    m_path_vertices.clear();
    m_commands.clear();
    m_clips.clear();
    m_clips.push_back(
        {.left = 0, .top = 0, .right = target.size.width, .bottom = target.size.height}
    );
    m_translations.clear();
    m_translations.push_back({});
    m_layers.clear();
}

auto draw_list::push_clip(const rect& area) -> void {
    LUCENT_INVARIANT(std::ssize(m_clips) <= max_clip_depth);
    m_clips.push_back(intersect(clip(), to_pixel_rect(snapped(area))));
}

auto draw_list::pop_clip() -> void {
    const isize floor = m_layers.empty() ? 1 : m_layers.back() + 1;
    LUCENT_INVARIANT(std::ssize(m_clips) > floor);
    m_clips.pop_back();
}

auto draw_list::push_translation(vec2 offset) -> void {
    LUCENT_INVARIANT(std::ssize(m_translations) <= max_translation_depth);
    const vec2 whole{.x = snap(offset.x * m_scale), .y = snap(offset.y * m_scale)};
    m_translations.push_back(m_translations.back() + whole);
}

auto draw_list::pop_translation() -> void {
    LUCENT_INVARIANT(std::ssize(m_translations) > 1);
    m_translations.pop_back();
}

auto draw_list::push_layer(const layer& surface) -> void {
    LUCENT_INVARIANT(std::ssize(m_layers) < max_layer_depth);
    LUCENT_INVARIANT(std::ssize(m_clips) <= max_clip_depth);
    LUCENT_INVARIANT(std::ssize(m_commands) < max_commands);
    const rect bounds = snapped(surface.bounds);
    const layer in_pixels{
        .bounds = bounds,
        .radius = std::max(0.0F, surface.radius * m_scale),
        .opacity = std::clamp(surface.opacity, 0.0F, 1.0F),
        .blur = std::clamp(surface.blur * m_scale, 0.0F, max_layer_blur),
        // The rim bends the blurred backdrop, so without a blur there is nothing to bend.
        .rim = surface.blur > 0.0F ? std::max(0.0F, surface.rim * m_scale) : 0.0F,
        .should_sample_light = surface.should_sample_light,
    };
    m_commands.emplace_back(layer_begin{.surface = in_pixels, .clip = clip()});
    m_layers.push_back(std::ssize(m_clips));
    m_clips.push_back(intersect(clip(), to_pixel_rect(bounds)));
}

auto draw_list::pop_layer() -> void {
    LUCENT_INVARIANT(!m_layers.empty());
    LUCENT_INVARIANT(std::ssize(m_clips) == m_layers.back() + 1);
    LUCENT_INVARIANT(std::ssize(m_commands) < max_commands);
    m_clips.pop_back();
    m_layers.pop_back();
    m_commands.emplace_back(layer_end{});
}

auto draw_list::fill(const rounded_rect& shape, const paint& with) -> void {
    const rect bounds = snapped(shape.bounds);
    const quad_record record{
        .rect = as_array(bounds),
        .geometry = clamped(scaled(shape.radii, m_scale), bounds),
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of(
            {.with = with, .kinds = {.quad = quad_kind::rounded_rect, .paint = with.kind}}
        ),
    };
    if (!is_invisible(with)) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::fill(const circle& shape, const paint& with) -> void {
    const f32 radius = shape.radius * m_scale;
    const rect bounds = circle_rect(to_pixels(shape.centre), radius);
    const quad_record record{
        .rect = as_array(bounds),
        .geometry = clamped(uniform(radius), bounds),
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of(
            {.with = with, .kinds = {.quad = quad_kind::rounded_rect, .paint = with.kind}}
        ),
    };
    if (!is_invisible(with) && radius > 0.0F) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::stroke(const rounded_rect& shape, const paint& with, const stroke_style& style)
    -> void {
    const rect bounds = snapped(shape.bounds);
    const quad_record record{
        .rect = as_array(bounds),
        .geometry = clamped(scaled(shape.radii, m_scale), bounds),
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of({
            .with = with,
            .kinds = {.quad = quad_kind::rounded_rect, .paint = with.kind},
            .stroke = stroke_width(style.width),
        }),
    };
    if (!is_invisible(with) && style.width > 0.0F) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::stroke(const circle& shape, const paint& with, const stroke_style& style) -> void {
    const f32 radius = shape.radius * m_scale;
    const rect bounds = circle_rect(to_pixels(shape.centre), radius);
    const quad_record record{
        .rect = as_array(bounds),
        .geometry = clamped(uniform(radius), bounds),
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of({
            .with = with,
            .kinds = {.quad = quad_kind::rounded_rect, .paint = with.kind},
            .stroke = stroke_width(style.width),
        }),
    };
    if (!is_invisible(with) && radius > 0.0F && style.width > 0.0F) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::stroke(const arc& shape, const paint& with, const stroke_style& style) -> void {
    const f32 radius = shape.radius * m_scale;
    const f32 half_band = stroke_width(style.width) * 0.5F;
    const f32 half_sweep = std::min(std::abs(shape.sweep) * 0.5F, std::numbers::pi_v<f32>);
    const quad_record record{
        .rect = as_array(circle_rect(to_pixels(shape.centre), radius + half_band)),
        .geometry = {radius, half_band, half_sweep, wrapped(shape.start + (shape.sweep * 0.5F))},
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of({.with = with, .kinds = {.quad = quad_kind::arc, .paint = with.kind}}),
    };
    if (!is_invisible(with) && radius > 0.0F && half_band > 0.0F && half_sweep > 0.0F) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::stroke(const segment& shape, const paint& with, const stroke_style& style) -> void {
    vec2 start = to_pixels(shape.from);
    vec2 end = to_pixels(shape.to);
    const f32 half_width = stroke_width(style.width) * 0.5F;
    // A level or plumb segment is an axis-aligned edge: its band and its ends land on pixel edges.
    constexpr f32 level = 1.0e-3F;
    if (std::abs(end.y - start.y) < level) {
        start = {.x = snap(start.x), .y = aligned(start.y, half_width)};
        end = {.x = snap(end.x), .y = start.y};
    } else if (std::abs(end.x - start.x) < level) {
        start = {.x = aligned(start.x, half_width), .y = snap(start.y)};
        end = {.x = start.x, .y = snap(end.y)};
    }
    const vec2 half = (end - start) * 0.5F;
    const vec2 centre = start + half;
    // A butt-capped segment of no length covers nothing; a round-capped one is a dot.
    const bool is_empty_line =
        std::abs(half.x) + std::abs(half.y) < level && style.ends == cap::butt;
    const vec2 extent{.x = std::abs(half.x) + half_width, .y = std::abs(half.y) + half_width};
    const quad_record record{
        .rect = as_array({.min = centre - extent, .max = centre + extent}),
        .geometry = {half.x, half.y, half_width, 0.0F},
        .gradient = gradient_of(in_pixels(with)),
        .style = style_of({
            .with = with,
            .kinds = {.quad = quad_kind::segment, .paint = with.kind, .ends = style.ends},
        }),
    };
    if (!is_invisible(with) && half_width > 0.0F && !is_empty_line) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::shadow(const rounded_rect& shape, const shadow_style& style) -> void {
    const rect moved{
        .min = shape.bounds.min + style.offset,
        .max = shape.bounds.max + style.offset,
    };
    const rect bounds = grown(snapped(moved), style.spread * m_scale);
    const corners radii = scaled(shape.radii, m_scale);
    const f32 spread = style.spread * m_scale;
    const corners spread_radii{
        .top_left = radii.top_left + spread,
        .top_right = radii.top_right + spread,
        .bottom_right = radii.bottom_right + spread,
        .bottom_left = radii.bottom_left + spread,
    };
    const paint tint = solid(style.tint);
    const quad_record record{
        .rect = as_array(bounds),
        .geometry = clamped(spread_radii, bounds),
        .gradient = {},
        .style = style_of({
            .with = tint,
            .kinds = {.quad = quad_kind::rounded_rect},
            .softness = std::max(0.0F, style.blur * m_scale),
        }),
    };
    if (!is_invisible(tint) && !is_empty(bounds)) {
        add_record(record, std::nullopt);
    }
}

auto draw_list::fill_convex(std::span<const vec2> outline, color tint) -> void {
    add_path(m_paths->fill_convex(points_in_pixels(outline), tint));
}

auto draw_list::fill_polygon(std::span<const vec2> outline, color tint) -> void {
    add_path(m_paths->fill_polygon(points_in_pixels(outline), tint));
}

auto draw_list::stroke(const path_stroke& path) -> void {
    std::vector<f32> widths;
    widths.reserve(path.widths.size());
    for (const f32 width : path.widths) {
        widths.push_back(width * m_scale);
    }
    const path_stroke in_pixels{
        .points = points_in_pixels(path.points),
        .tints = path.tints,
        .widths = widths,
        .tint = path.tint,
        .width = path.width * m_scale,
        .feather = path.feather * m_scale,
        .ends = path.ends,
    };
    add_path(m_paths->stroke(in_pixels));
}

auto draw_list::draw(const image_quad& quad) -> void {
    const quad_record record{
        .rect = as_array(snapped(quad.bounds)),
        .geometry = as_array(quad.uv),
        .gradient = {},
        .style = style_of({.with = solid(quad.tint), .kinds = {.quad = quad_kind::image}}),
    };
    if (quad.tint.a != 0) {
        add_record(record, quad.image);
    }
}

auto draw_list::draw(const glyph_run& run) -> void {
    const vec2 exact = to_pixels(run.origin);
    const vec2 origin{.x = snap(exact.x), .y = snap(exact.y)};
    for (const glyph_quad& glyph : run.glyphs) {
        const quad_record record{
            .rect = as_array({.min = origin + glyph.bounds.min, .max = origin + glyph.bounds.max}),
            .geometry = as_array(glyph.uv),
            .gradient = {},
            .style = style_of({
                .with = solid(glyph.tint),
                .kinds = {.quad = quad_kind::atlas, .page = glyph.page},
            }),
        };
        if (glyph.tint.a != 0) {
            add_record(record, std::nullopt);
        }
    }
}

auto draw_list::frame() const -> frame_data {
    LUCENT_INVARIANT(m_layers.empty() && m_clips.size() == 1 && m_translations.size() == 1);
    return {
        .target = m_target,
        .records = m_records,
        .path_vertices = m_path_vertices,
        .commands = m_commands,
    };
}

auto draw_list::add_record(const quad_record& record, std::optional<image_handle> image) -> void {
    const f32 softness = from_half(narrow<u16>(record.style[3] & 0xffffU));
    const rect reached = grown(from_array(record.rect), reach(softness));
    if (is_outside(reached, clip())) {
        return;
    }
    LUCENT_INVARIANT(std::ssize(m_records) < max_records);
    quad_run* const run = open_quad_run(m_commands);
    const isize index = std::ssize(m_records);
    m_records.push_back(record);
    const bool can_join =
        run != nullptr && run->clip == clip() && (!image || !run->image || run->image == image);
    if (can_join) {
        run->count += 1;
        if (image) {
            run->image = image;
        }
        return;
    }
    LUCENT_INVARIANT(std::ssize(m_commands) < max_commands);
    m_commands.emplace_back(quad_run{.clip = clip(), .first = index, .count = 1, .image = image});
}

auto draw_list::add_path(std::span<const path_vertex> vertices) -> void {
    if (vertices.empty() || is_outside(bounds_of(vertices), clip())) {
        return;
    }
    LUCENT_INVARIANT(std::ssize(m_path_vertices) + std::ssize(vertices) <= max_path_vertices);
    const isize first = std::ssize(m_path_vertices);
    m_path_vertices.insert(m_path_vertices.end(), vertices.begin(), vertices.end());
    path_run* const run = open_path_run(m_commands);
    if (run != nullptr && run->clip == clip()) {
        run->count += std::ssize(vertices);
        return;
    }
    LUCENT_INVARIANT(std::ssize(m_commands) < max_commands);
    m_commands.emplace_back(
        path_run{.clip = clip(), .first = first, .count = std::ssize(vertices)}
    );
}

auto draw_list::to_pixels(vec2 point) const -> vec2 {
    return (point * m_scale) + m_translations.back();
}

auto draw_list::snapped(const rect& box) const -> rect {
    const vec2 offset = m_translations.back();
    // A side one unit long or less keeps whole pixels of its own, so a hairline rect is the same
    // thickness wherever it starts.
    const auto side = [this](f32 low, f32 high) {
        const f32 start = snap(low * m_scale);
        const f32 length = high - low;
        const f32 end = length <= 1.0F && length > 0.0F
                            ? start + std::max(1.0F, snap(length * m_scale))
                            : snap(high * m_scale);
        return std::array<f32, 2>{start, end};
    };
    const std::array<f32, 2> horizontal = side(box.min.x, box.max.x);
    const std::array<f32, 2> vertical = side(box.min.y, box.max.y);
    return {
        .min = {.x = horizontal[0] + offset.x, .y = vertical[0] + offset.y},
        .max = {.x = horizontal[1] + offset.x, .y = vertical[1] + offset.y},
    };
}

auto draw_list::stroke_width(f32 width) const -> f32 {
    if (width <= 0.0F) {
        return 0.0F;
    }
    return width <= 1.0F ? std::max(1.0F, snap(width * m_scale)) : width * m_scale;
}

auto draw_list::in_pixels(const paint& with) const -> paint {
    return {
        .kind = with.kind,
        .from = with.from,
        .to = with.to,
        .start = to_pixels(with.start),
        .end = to_pixels(with.end),
    };
}

auto draw_list::points_in_pixels(std::span<const vec2> points) -> std::span<const vec2> {
    m_scratch_points.clear();
    for (const vec2 point : points) {
        m_scratch_points.push_back(to_pixels(point));
    }
    return m_scratch_points;
}

auto draw_list::clip() const -> const pixel_rect& {
    return m_clips.back();
}

}
