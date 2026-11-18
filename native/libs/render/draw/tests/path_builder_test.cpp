#include "../src/path_builder.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <numbers>
#include <ranges>
#include <span>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/testing/invariant_violation.hpp>

namespace lucent::draw::detail {
namespace {

// Below this a triangle's doubled area is rounding, not a winding.
constexpr f64 flat_area = 1.0e-3;

constexpr color ink{.r = 40, .g = 160, .b = 220, .a = 255};

auto wide(f32 value) -> f64 {
    return static_cast<f64>(value);
}

auto wide(u8 value) -> f64 {
    return static_cast<f64>(value);
}

// An outline from its coordinates, x then y for each point.
auto outline_of(std::initializer_list<f32> coordinates) -> std::vector<vec2> {
    std::vector<vec2> outline;
    for (const auto pair : coordinates | std::views::chunk(2)) {
        outline.push_back({.x = pair.front(), .y = pair.back()});
    }
    return outline;
}

auto reversed(std::span<const vec2> outline) -> std::vector<vec2> {
    return {outline.rbegin(), outline.rend()};
}

using triangle = std::array<path_vertex, 3>;

auto triangles_of(std::span<const path_vertex> vertices) -> std::vector<triangle> {
    std::vector<triangle> triangles;
    for (const auto corners : vertices | std::views::chunk(3)) {
        triangle each{};
        std::ranges::copy(corners, each.begin());
        triangles.push_back(each);
    }
    return triangles;
}

auto doubled_area(const triangle& corners) -> f64 {
    const vec2 first = corners.at(0).position;
    const vec2 second = corners.at(1).position;
    const vec2 third = corners.at(2).position;
    return ((wide(second.x) - wide(first.x)) * (wide(third.y) - wide(first.y)))
           - ((wide(second.y) - wide(first.y)) * (wide(third.x) - wide(first.x)));
}

auto mean_alpha(const triangle& corners) -> f64 {
    return (wide(corners.at(0).tint.a) + wide(corners.at(1).tint.a) + wide(corners.at(2).tint.a))
           / (3.0 * 255.0);
}

auto is_finite(std::span<const path_vertex> vertices) -> bool {
    return std::ranges::all_of(vertices, [](const path_vertex& vertex) {
        return std::isfinite(vertex.position.x) && std::isfinite(vertex.position.y);
    });
}

// Every triangle clockwise on screen, or too thin to have a side.
auto is_clockwise(std::span<const path_vertex> vertices) -> bool {
    return vertices.size() % 3 == 0
           && std::ranges::all_of(triangles_of(vertices), [](const triangle& corners) {
                  return doubled_area(corners) >= -flat_area;
              });
}

// The area the triangles cover, each weighted by its mean alpha: what a blend over a black target
// would add up to, overlaps counted twice.
auto coverage(std::span<const path_vertex> vertices) -> f64 {
    f64 covered = 0.0;
    for (const triangle& corners : triangles_of(vertices)) {
        covered += 0.5 * doubled_area(corners) * mean_alpha(corners);
    }
    return covered;
}

// Each point and the one after it, the last followed by the first.
auto next_of(std::span<const vec2> points, isize index) -> vec2 {
    return points.subspan(narrow<usize>((index + 1) % std::ssize(points))).front();
}

auto area_of(std::span<const vec2> outline) -> f64 {
    f64 doubled = 0.0;
    for (const auto [index, point] : std::views::enumerate(outline)) {
        const vec2 next = next_of(outline, index);
        doubled += (wide(point.x) * wide(next.y)) - (wide(next.x) * wide(point.y));
    }
    return std::abs(doubled) * 0.5;
}

auto length_of(std::span<const vec2> points, path_end ends) -> f64 {
    const isize segments = ends == path_end::closed ? std::ssize(points) : std::ssize(points) - 1;
    f64 total = 0.0;
    for (const auto [index, point] : std::views::enumerate(points) | std::views::take(segments)) {
        const vec2 offset = next_of(points, index) - point;
        total += std::sqrt(wide(dot(offset, offset)));
    }
    return total;
}

// A fringe off-centre by half a pixel moves a quarter of the perimeter's worth of coverage, so
// the allowance tied to the perimeter is a tenth of that; each corner may add or lose a little
// where its fringe bands meet.
auto fill_tolerance(std::span<const vec2> outline) -> f64 {
    return (0.025 * length_of(outline, path_end::closed))
           + (0.5 * static_cast<f64>(outline.size()));
}

auto is_area_kept(std::span<const path_vertex> vertices, std::span<const vec2> outline) -> bool {
    return std::abs(coverage(vertices) - area_of(outline)) <= fill_tolerance(outline);
}

struct bounds {
    vec2 low;
    vec2 high;
};

auto is_inside(vec2 point, bounds box) -> bool {
    return point.x >= box.low.x
           && point.x <= box.high.x
           && point.y >= box.low.y
           && point.y <= box.high.y;
}

auto is_within(std::span<const path_vertex> vertices, bounds box) -> bool {
    return std::ranges::all_of(vertices, [box](const path_vertex& vertex) {
        return is_inside(vertex.position, box);
    });
}

// The outline's bounds grown by `margin` on every side.
auto bounds_of(std::span<const vec2> outline, f32 margin) -> bounds {
    const auto [left, right] = std::ranges::minmax(outline | std::views::transform(&vec2::x));
    const auto [top, bottom] = std::ranges::minmax(outline | std::views::transform(&vec2::y));
    return {
        .low = {.x = left - margin, .y = top - margin},
        .high = {.x = right + margin, .y = bottom + margin},
    };
}

// Finite, clockwise, and no further out than a couple of pixels past the outline's bounds.
auto is_sound(std::span<const path_vertex> vertices, std::span<const vec2> outline) -> bool {
    return is_finite(vertices)
           && is_clockwise(vertices)
           && is_within(vertices, bounds_of(outline, 2.0F));
}

auto is_sound_fill(std::span<const path_vertex> vertices, std::span<const vec2> outline) -> bool {
    return is_sound(vertices, outline) && is_area_kept(vertices, outline);
}

struct star_shape {
    vec2 centre;
    f32 outer = 0.0F;
    f32 inner = 0.0F;
    isize spikes = 0;
};

auto star(const star_shape& shape) -> std::vector<vec2> {
    std::vector<vec2> outline;
    for (isize k = 0; k < shape.spikes * 2; ++k) {
        const f32 angle =
            std::numbers::pi_v<f32> * static_cast<f32>(k) / static_cast<f32>(shape.spikes);
        const f32 radius = k % 2 == 0 ? shape.outer : shape.inner;
        outline.push_back(
            shape.centre + (vec2{.x = std::sin(angle), .y = -std::cos(angle)} * radius)
        );
    }
    return outline;
}

// A regular polygon with an even number of corners.
auto circle(isize corners) -> std::vector<vec2> {
    return star({
        .centre = {.x = 500, .y = 500},
        .outer = 400,
        .inner = 400,
        .spikes = corners / 2,
    });
}

// Star-shaped outlines from a fixed sequence (splitmix64), the same on every run and toolchain.
class outline_source {
public:
    // Corners at increasing angles around a centre, each at its own radius, its features a few
    // pixels or more across.
    auto next_outline() -> std::vector<vec2> {
        const auto corners = 3 + static_cast<isize>(unit() * 40.0F);
        std::vector<vec2> outline;
        for (isize k = 0; k < corners; ++k) {
            const f32 turn = (static_cast<f32>(k) + (0.9F * unit())) / static_cast<f32>(corners);
            const f32 angle = 2.0F * std::numbers::pi_v<f32> * turn;
            const f32 radius = 40.0F + (60.0F * unit());
            outline.push_back(
                vec2{.x = 300, .y = 300}
                + (vec2{.x = std::cos(angle), .y = std::sin(angle)} * radius)
            );
        }
        return outline;
    }

private:
    auto unit() -> f32 {
        m_state += 0x9e37'79b9'7f4a'7c15U;
        u64 mixed = m_state;
        mixed = (mixed ^ (mixed >> 30U)) * 0xbf58'476d'1ce4'e5b9U;
        mixed = (mixed ^ (mixed >> 27U)) * 0x94d0'49bb'1331'11ebU;
        mixed ^= mixed >> 31U;
        return static_cast<f32>(mixed >> 40U) / static_cast<f32>(1U << 24U);
    }

    u64 m_state = 20'261'118U;
};

// A stroke of one tint and width, the feather left at its pixel.
auto plain(std::span<const vec2> points, f32 width, path_end ends) -> path_stroke {
    return {
        .points = points,
        .tints = {},
        .widths = {},
        .tint = ink,
        .width = width,
        .feather = 1.0F,
        .ends = ends,
    };
}

}

TEST_CASE("a convex fill covers its area with every triangle clockwise, in either winding") {
    path_builder builder;
    const std::vector<vec2> square = outline_of({10, 10, 110, 10, 110, 110, 10, 110});
    const std::vector<vec2> round = star({
        .centre = {.x = 200, .y = 200},
        .outer = 50,
        .inner = 50,
        .spikes = 24,
    });
    for (const std::vector<vec2>& outline : {square, reversed(square), round, reversed(round)}) {
        CHECK(is_sound_fill(builder.fill_convex(outline, ink), outline));
        CHECK(is_sound_fill(builder.fill_polygon(outline, ink), outline));
    }
}

TEST_CASE("a fill's fringe straddles the edge: half a pixel in, half a pixel out") {
    path_builder builder;
    const std::vector<vec2> square = outline_of({10, 10, 110, 10, 110, 110, 10, 110});
    const std::span<const path_vertex> vertices = builder.fill_convex(square, ink);
    CHECK(is_within(vertices, bounds_of(square, 0.5F)));
    CHECK_FALSE(is_within(vertices, bounds_of(square, 0.4F)));
    // Only the fringe's outer side is clear.
    const bounds edge = bounds_of(square, 0.0F);
    CHECK(std::ranges::all_of(vertices, [edge](const path_vertex& vertex) {
        return is_inside(vertex.position, edge) || vertex.tint.a == 0;
    }));
}

TEST_CASE("a concave L fills its area in either winding") {
    path_builder builder;
    const std::vector<vec2> shape = outline_of({0, 0, 60, 0, 60, 15, 15, 15, 15, 60, 0, 60});
    CHECK(is_sound_fill(builder.fill_polygon(shape, ink), shape));
    CHECK(is_sound_fill(builder.fill_polygon(reversed(shape), ink), shape));
}

TEST_CASE("a star with sharp spikes fills its area in either winding") {
    path_builder builder;
    for (const isize spikes : {5, 7, 12}) {
        const std::vector<vec2> shape = star({
            .centre = {.x = 100, .y = 100},
            .outer = 80,
            .inner = 30,
            .spikes = spikes,
        });
        CHECK(is_sound_fill(builder.fill_polygon(shape, ink), shape));
        CHECK(is_sound_fill(builder.fill_polygon(reversed(shape), ink), shape));
    }
}

TEST_CASE("two squares touching at one corner fill as one outline") {
    path_builder builder;
    const std::vector<vec2> shape =
        outline_of({0, 0, 40, 0, 40, 40, 80, 40, 80, 80, 40, 80, 40, 40, 0, 40});
    const bounds top_right{.low = {.x = 41, .y = -10}, .high = {.x = 90, .y = 39}};
    const bounds bottom_left{.low = {.x = -10, .y = 41}, .high = {.x = 39, .y = 90}};
    for (const std::vector<vec2>& outline : {shape, reversed(shape)}) {
        const std::span<const path_vertex> vertices = builder.fill_polygon(outline, ink);
        CHECK(is_sound_fill(vertices, shape));
        // Nothing reaches into the two empty quadrants further than the fringe and the pinch.
        CHECK(std::ranges::none_of(vertices, [top_right, bottom_left](const path_vertex& vertex) {
            return is_inside(vertex.position, top_right) || is_inside(vertex.position, bottom_left);
        }));
    }
}

TEST_CASE("an outline that revisits its vertices to cut a hole fills around the hole") {
    path_builder builder;
    // Out along the square, back to its first corner, across to the hole and round it the other
    // way, and back across.
    const std::vector<vec2> shape =
        outline_of({0, 0, 60, 0, 60, 60, 0, 60, 0, 0, 20, 20, 20, 40, 40, 40, 40, 20, 20, 20});
    const f64 area = (60.0 * 60.0) - (20.0 * 20.0);
    const bounds hole{.low = {.x = 21, .y = 21}, .high = {.x = 39, .y = 39}};
    for (const std::vector<vec2>& outline : {shape, reversed(shape)}) {
        const std::span<const path_vertex> vertices = builder.fill_polygon(outline, ink);
        CHECK(is_sound(vertices, shape));
        CHECK(std::abs(coverage(vertices) - area) <= fill_tolerance(shape));
        CHECK(std::ranges::none_of(vertices, [hole](const path_vertex& vertex) {
            return is_inside(vertex.position, hole);
        }));
    }
}

TEST_CASE("random star-shaped outlines of pixel-sized detail fill their area, all clockwise") {
    path_builder builder;
    outline_source source;
    for (isize round = 0; round < 200; ++round) {
        const std::vector<vec2> outline = source.next_outline();
        CHECK(is_sound_fill(builder.fill_polygon(outline, ink), outline));
    }
}

TEST_CASE("fills of fewer than three distinct points or a clear tint are empty") {
    path_builder builder;
    CHECK(builder.fill_polygon({}, ink).empty());
    CHECK(builder.fill_polygon(outline_of({0, 0, 10, 10}), ink).empty());
    CHECK(builder.fill_convex(outline_of({5, 5, 5, 5, 5, 5, 5, 5}), ink).empty());
    CHECK(builder.fill_polygon(outline_of({5, 5, 5, 5, 5, 5, 5, 5}), ink).empty());
    CHECK(builder.fill_polygon(outline_of({0, 0, 10, 0, 10, 0, 0, 0}), ink).empty());
    CHECK(builder.fill_polygon(outline_of({0, 0, 10, 0, 0, 10}), transparent).empty());
}

TEST_CASE("degenerate fills yield no NaN, nothing overturned and nothing far out") {
    path_builder builder;
    // Collinear, a needle, a spike that doubles back, a bowtie, a sliver thinner than the fringe,
    // and a concave outline handed to the convex fill.
    const std::vector<std::vector<vec2>> outlines{
        outline_of({0, 0, 10, 0, 20, 0, 30, 0}),
        outline_of({0, 0, 100, 0, 0, 0.001F}),
        outline_of({0, 0, 20, 0, 40, 0, 20, 0, 20, 20, 0, 20}),
        outline_of({0, 0, 40, 40, 40, 0, 0, 40}),
        outline_of({0, 0, 50, 0, 50, 0.3F, 0, 0.3F}),
        outline_of({0, 0, 60, 0, 60, 15, 15, 15, 15, 60, 0, 60}),
    };
    for (const std::vector<vec2>& outline : outlines) {
        CHECK(is_sound(builder.fill_polygon(outline, ink), outline));
        CHECK(is_sound(builder.fill_convex(outline, ink), outline));
    }
    const f32 nan = std::numeric_limits<f32>::quiet_NaN();
    CHECK(builder.fill_polygon(outline_of({0, 0, nan, 0, 0, 10}), ink).empty());
}

TEST_CASE("repeated points fill as if given once") {
    path_builder builder;
    const std::vector<vec2> repeats =
        outline_of({0, 0, 0, 0, 20, 0, 20, 0, 20, 20, 20, 20, 0, 20, 0, 0});
    const std::vector<vec2> square = outline_of({0, 0, 20, 0, 20, 20, 0, 20});
    CHECK(is_sound_fill(builder.fill_polygon(repeats, ink), square));
}

TEST_CASE("an open stroke covers its length times its width") {
    path_builder builder;
    const std::vector<vec2> points = outline_of({10, 10, 110, 10, 110, 60, 180, 120});
    for (const f32 width : {0.5F, 1.0F, 3.0F, 12.0F}) {
        const std::span<const path_vertex> vertices =
            builder.stroke(plain(points, width, path_end::open));
        CHECK(is_finite(vertices));
        CHECK(is_clockwise(vertices));
        const f64 expected = length_of(points, path_end::open) * wide(width);
        // The joins add about a half width squared on the outside of each turn.
        const f64 allowance = (0.01 * expected) + (wide(width) * wide(width));
        CHECK(std::abs(coverage(vertices) - expected) <= allowance);
    }
}

TEST_CASE("a closed stroke covers its perimeter times its width and joins its ends") {
    path_builder builder;
    const std::vector<vec2> square = outline_of({20, 20, 120, 20, 120, 120, 20, 120});
    const f32 width = 6.0F;
    const std::span<const path_vertex> vertices =
        builder.stroke(plain(square, width, path_end::closed));
    CHECK(is_finite(vertices));
    CHECK(is_clockwise(vertices));
    // A mitered square ring: its outer square less its inner one.
    const f64 ring = (106.0 * 106.0) - (94.0 * 94.0);
    CHECK(std::abs(coverage(vertices) - ring) <= 4.0 * wide(width) * wide(width));
    // The miter reaches the outer corner and the feather half a pixel past it.
    CHECK(is_within(vertices, bounds_of(square, 3.5F)));
    CHECK_FALSE(is_within(vertices, bounds_of(square, 2.5F)));
}

TEST_CASE("a stroke blends tint and width per point") {
    path_builder builder;
    const std::vector<vec2> points = outline_of({0, 0, 100, 0, 100, 100});
    const std::array<color, 3> tints{ink, with_alpha(ink, 128), with_alpha(ink, 0)};
    const std::array<f32, 3> widths{2.0F, 8.0F, 2.0F};
    const std::span<const path_vertex> vertices = builder.stroke({
        .points = points,
        .tints = tints,
        .widths = widths,
        .tint = white,
        .width = 1.0F,
        .feather = 1.0F,
        .ends = path_end::closed,
    });
    CHECK(is_finite(vertices));
    CHECK(is_clockwise(vertices));
    CHECK(std::ranges::any_of(vertices, [](const path_vertex& vertex) {
        return vertex.tint == with_alpha(ink, 128);
    }));
    // Only the wide middle point reaches four pixels plus half the feather above the path.
    CHECK(is_within(vertices, bounds_of(points, 10.0F)));
    CHECK(std::ranges::any_of(vertices, [](const path_vertex& vertex) {
        return vertex.position.y < -4.0F;
    }));
}

TEST_CASE("a tapering open stroke covers its length times its mean width") {
    path_builder builder;
    const std::vector<vec2> points = outline_of({0, 0, 100, 0, 200, 0});
    const std::array<f32, 3> widths{2.0F, 10.0F, 4.0F};
    const std::span<const path_vertex> vertices = builder.stroke({
        .points = points,
        .tints = {},
        .widths = widths,
        .tint = ink,
        .width = 1.0F,
        .feather = 1.0F,
        .ends = path_end::open,
    });
    CHECK(is_clockwise(vertices));
    const f64 expected = (100.0 * 6.0) + (100.0 * 7.0);
    CHECK(std::abs(coverage(vertices) - expected) <= 0.01 * expected);
}

TEST_CASE("a join sharper than the miter limit is beveled") {
    path_builder builder;
    // About eleven degrees between the segments: a miter would reach ten half widths.
    const std::vector<vec2> points = outline_of({0, 0, 200, 0, 0, 40});
    const std::span<const path_vertex> vertices =
        builder.stroke(plain(points, 10.0F, path_end::open));
    CHECK(is_clockwise(vertices));
    CHECK(is_within(vertices, bounds_of(points, 10.0F)));
}

TEST_CASE("a stroke with short segments and sharp turns overturns no triangle") {
    path_builder builder;
    std::vector<vec2> zigzag(64);
    for (const auto [index, point] : std::views::enumerate(zigzag)) {
        point = {.x = static_cast<f32>(index) * 0.7F, .y = index % 2 == 0 ? 0.0F : 3.0F};
    }
    for (const path_end ends : {path_end::open, path_end::closed}) {
        for (const f32 width : {0.3F, 2.0F, 20.0F}) {
            const std::span<const path_vertex> vertices =
                builder.stroke(plain(zigzag, width, ends));
            CHECK(is_finite(vertices));
            CHECK(is_clockwise(vertices));
        }
    }
}

TEST_CASE("degenerate strokes yield nothing, or nothing overturned and no NaN") {
    path_builder builder;
    const f32 nan = std::numeric_limits<f32>::quiet_NaN();
    CHECK(builder.stroke(plain(outline_of({5, 5}), 1.0F, path_end::open)).empty());
    CHECK(builder.stroke(plain(outline_of({5, 5, 5, 5, 5, 5}), 1.0F, path_end::closed)).empty());
    CHECK(builder.stroke(plain(outline_of({0, 0, nan, 0}), 1.0F, path_end::open)).empty());
    const std::vector<vec2> back = outline_of({0, 0, 50, 0, 0, 0});
    for (const path_end ends : {path_end::open, path_end::closed}) {
        const std::span<const path_vertex> vertices = builder.stroke(plain(back, 4.0F, ends));
        CHECK(is_finite(vertices));
        CHECK(is_clockwise(vertices));
    }
}

TEST_CASE("a stroke of no width, or of a width or feather that is not a number, covers nothing") {
    path_builder builder;
    const f32 nan = std::numeric_limits<f32>::quiet_NaN();
    const std::vector<vec2> line = outline_of({0, 0, 50, 0});
    for (const f32 width : {0.0F, -3.0F, nan}) {
        path_stroke path = plain(line, width, path_end::open);
        path.feather = nan;
        const std::span<const path_vertex> vertices = builder.stroke(path);
        CHECK(is_finite(vertices));
        CHECK(coverage(vertices) <= 0.0);
    }
}

TEST_CASE("per-point spans that do not match the points break the invariant") {
    path_builder builder;
    const std::vector<vec2> points = outline_of({0, 0, 10, 0, 10, 10});
    const std::array<color, 2> tints{ink, ink};
    const std::array<f32, 4> widths{1, 1, 1, 1};
    path_stroke tinted = plain(points, 1.0F, path_end::open);
    tinted.tints = tints;
    path_stroke tapered = plain(points, 1.0F, path_end::open);
    tapered.widths = widths;
    CHECK_THROWS_AS(std::ignore = builder.stroke(tinted), testing::invariant_violation);
    CHECK_THROWS_AS(std::ignore = builder.stroke(tapered), testing::invariant_violation);
}

TEST_CASE("more points than a path takes break the invariant") {
    path_builder builder;
    const std::vector<vec2> too_many = circle(max_path_points + 2);
    CHECK_THROWS_AS(
        std::ignore = builder.fill_polygon(too_many, ink), testing::invariant_violation
    );
    CHECK_THROWS_AS(
        std::ignore = builder.stroke(plain(too_many, 1.0F, path_end::open)),
        testing::invariant_violation
    );
    const std::vector<vec2> most = circle(max_path_points);
    CHECK(is_sound_fill(builder.fill_polygon(most, ink), most));
}

}
