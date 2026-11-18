#include "path_builder.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <optional>
#include <ranges>
#include <span>
#include <tuple>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw::detail {
namespace {

// Points closer than this are one point: an edge any shorter has no direction worth trusting.
constexpr f32 same_point_distance = 1.0F / 1024.0F;

// Twice a triangle's area, in square pixels, below which it covers nothing and is not emitted.
constexpr f32 degenerate_area = 1.0e-6F;

// The sine of a turn below which a corner counts as straight on, or as turning straight back.
constexpr f32 straight_turn = 1.0e-4F;

// How far a stroke's miter may reach, in half widths (SVG's default); past it the join is
// beveled, as a sharp corner would otherwise throw a spike.
constexpr f32 miter_limit = 4.0F;

// How far a fill's corner may move inward, in half fringes: eight pixels. Its inset is exact for
// edges longer than that however sharp the corner, and a limit short of the true miter would
// leave the body opaque where the fringe should fade. Only a tip sharper than about seven degrees
// reaches it.
constexpr f32 inset_limit = 16.0F;

// Half of a fill's one-pixel fringe: it straddles the true edge.
constexpr f32 half_fringe = 0.5F;

// Checked reads from the caller's spans: std::span has no at() on the pinned toolchain.
auto element_at(std::span<const vec2> values, isize index) -> vec2 {
    LUCENT_INVARIANT(index >= 0 && index < std::ssize(values));
    return values.subspan(narrow<usize>(index)).front();
}

auto element_at(std::span<const isize> values, isize index) -> isize {
    LUCENT_INVARIANT(index >= 0 && index < std::ssize(values));
    return values.subspan(narrow<usize>(index)).front();
}

auto element_at(std::span<const f32> values, isize index) -> f32 {
    LUCENT_INVARIANT(index >= 0 && index < std::ssize(values));
    return values.subspan(narrow<usize>(index)).front();
}

auto element_at(std::span<const color> values, isize index) -> color {
    LUCENT_INVARIANT(index >= 0 && index < std::ssize(values));
    return values.subspan(narrow<usize>(index)).front();
}

auto length(vec2 offset) -> f32 {
    return std::sqrt(dot(offset, offset));
}

// Callers have dropped repeated points, so the two never coincide.
auto direction(vec2 tail, vec2 head) -> vec2 {
    const vec2 offset = head - tail;
    return offset * (1.0F / length(offset));
}

// The outward side of an edge running along `along` on a clockwise outline, and the left of a
// stroke's segment.
auto outward(vec2 along) -> vec2 {
    return {.x = along.y, .y = -along.x};
}

auto is_finite(vec2 point) -> bool {
    return std::isfinite(point.x) && std::isfinite(point.y);
}

auto doubled_area(vec2 first, vec2 second, vec2 third) -> f32 {
    return cross(second - first, third - first);
}

auto doubled_area(std::array<vec2, 3> corners) -> f32 {
    return doubled_area(corners.at(0), corners.at(1), corners.at(2));
}

auto is_same_point(vec2 first, vec2 second) -> bool {
    const vec2 offset = second - first;
    return dot(offset, offset) <= same_point_distance * same_point_distance;
}

// Inside a clockwise triangle, a point on its edge counting as inside.
auto is_inside(vec2 point, std::array<vec2, 3> corners) -> bool {
    const auto [first, second, third] = corners;
    return cross(second - first, point - first) >= 0.0F
           && cross(third - second, point - second) >= 0.0F
           && cross(first - third, point - third) >= 0.0F;
}

// The unit normals' sum scaled to reach where the two edges' parallels at unit distance meet: one
// over the cosine of half the turn. Past the inset limit it keeps the bisector's direction at the
// limit's length; edges that turn straight back have no bisector, and the arrival stands in.
// NOLINTNEXTLINE(bugprone-easily-swappable-parameters): symmetric in the two sides.
auto miter(vec2 before, vec2 after, vec2 arrival) -> vec2 {
    const vec2 sum = before + after;
    const f32 twice_cosine_squared = 1.0F + dot(before, after);
    if (twice_cosine_squared * inset_limit * inset_limit >= 2.0F) {
        return sum * (1.0F / twice_cosine_squared);
    }
    const f32 reach = length(sum);
    const vec2 bisector = reach > straight_turn ? sum * (1.0F / reach) : arrival;
    return bisector * inset_limit;
}

auto half_alpha(color tint) -> color {
    return with_alpha(tint, narrow<u8>(u32{tint.a} / 2U));
}

auto scaled_alpha(color tint, f32 factor) -> color {
    return with_alpha(tint, narrow<u8>(std::lround(static_cast<f32>(tint.a) * factor)));
}

// Three consecutive points of an outline, the middle one the corner.
struct corner_points {
    vec2 before;
    vec2 point;
    vec2 after;
};

enum class corner_turn : u8 { straight, convex, reflex };

// Turning straight back counts as convex: the outline's tip, turned half a circle.
auto turn_of(corner_points corner) -> corner_turn {
    const vec2 arrival = direction(corner.before, corner.point);
    const vec2 departure = direction(corner.point, corner.after);
    const f32 turning = cross(arrival, departure);
    if (turning > straight_turn) {
        return corner_turn::convex;
    }
    if (turning < -straight_turn) {
        return corner_turn::reflex;
    }
    return dot(arrival, departure) < 0.0F ? corner_turn::convex : corner_turn::straight;
}

// A fill's outline: the caller's points visited in `order`, by positions that wrap around, with
// what has been worked out per corner so far.
struct fill_view {
    std::span<const vec2> points;
    std::span<const isize> order;
    std::span<const vec2> inset;
    std::span<const isize> sharing;
};

auto wrapped(const fill_view& view, isize position) -> isize {
    const isize count = std::ssize(view.order);
    return ((position % count) + count) % count;
}

auto point_at(const fill_view& view, isize position) -> vec2 {
    return element_at(view.points, element_at(view.order, wrapped(view, position)));
}

auto inset_at(const fill_view& view, isize position) -> vec2 {
    return element_at(view.inset, wrapped(view, position));
}

auto corner_of(const fill_view& view, isize position) -> corner_points {
    return {
        .before = point_at(view, position - 1),
        .point = point_at(view, position),
        .after = point_at(view, position + 1),
    };
}

// An edge leaving a point: which way it goes and its outward side.
struct incident_edge {
    vec2 along;
    vec2 side;
};

// The inset of a body triangle's corner, given the direction the triangle opens in. A point the
// outline passes through more than once, as where it touches itself, has more than one corner,
// and that corner's own inset may lie in another of them: the triangle's is mitered between the
// edges either side of it among all the edges that meet at the point.
auto body_corner(const fill_view& view, isize position, vec2 inside) -> vec2 {
    // A triangle too flat to open anywhere is dropped later, whatever its corners.
    if (element_at(view.sharing, wrapped(view, position)) == 1 || length(inside) <= straight_turn) {
        return inset_at(view, position);
    }
    const vec2 corner = point_at(view, position);
    f32 clockwise = std::numbers::pi_v<f32> * 2.0F;
    f32 anticlockwise = clockwise;
    vec2 clockwise_side{};
    vec2 anticlockwise_side{};
    for (isize other = 0; other < std::ssize(view.order); ++other) {
        if (!is_same_point(point_at(view, other), corner)) {
            continue;
        }
        const vec2 before = point_at(view, other - 1);
        const vec2 after = point_at(view, other + 1);
        const std::array<incident_edge, 2> edges{
            incident_edge{.along = before - corner, .side = outward(direction(before, corner))},
            incident_edge{.along = after - corner, .side = outward(direction(corner, after))},
        };
        for (const incident_edge& edge : edges) {
            // An edge bounding the triangle faces away from it. One facing into it is the same
            // edge travelled back the other way, as along a bridge to a hole.
            if (dot(edge.side, inside) >= 0.0F) {
                continue;
            }
            const f32 angle = std::atan2(cross(inside, edge.along), dot(inside, edge.along));
            if (angle > 0.0F && angle < clockwise) {
                clockwise = angle;
                clockwise_side = edge.side;
            }
            if (angle <= 0.0F && -angle < anticlockwise) {
                anticlockwise = -angle;
                anticlockwise_side = edge.side;
            }
        }
    }
    const vec2 away = inside * (-1.0F / length(inside));
    return corner - (miter(clockwise_side, anticlockwise_side, away) * half_fringe);
}

// The triangle on three positions of the outline, its corners moved onto their insets.
auto inset_triangle(const fill_view& view, std::array<isize, 3> corners) -> std::array<vec2, 3> {
    std::array<vec2, 3> moved{};
    for (usize side = 0; side < corners.size(); ++side) {
        const vec2 corner = point_at(view, corners.at(side));
        const vec2 inside = direction(corner, point_at(view, corners.at((side + 1) % 3)))
                            + direction(corner, point_at(view, corners.at((side + 2) % 3)));
        moved.at(side) = body_corner(view, corners.at(side), inside);
    }
    return moved;
}

// Upright both on the outline's own corners and on the insets.
auto is_upright(const fill_view& view, std::array<isize, 3> corners) -> bool {
    const std::array<vec2, 3> own{
        point_at(view, corners.at(0)),
        point_at(view, corners.at(1)),
        point_at(view, corners.at(2)),
    };
    return doubled_area(own) > degenerate_area
           && doubled_area(inset_triangle(view, corners)) > degenerate_area;
}

// The corners ear clipping has left, as slots into `remaining`, which holds positions into the
// outline. Slots wrap around.
struct ear_ring {
    fill_view view;
    std::span<const isize> remaining;
};

auto position_at(const ear_ring& ring, isize slot) -> isize {
    const isize size = std::ssize(ring.remaining);
    return element_at(ring.remaining, ((slot % size) + size) % size);
}

auto corner_at(const ear_ring& ring, isize slot) -> vec2 {
    return point_at(ring.view, position_at(ring, slot));
}

auto ear_at(const ear_ring& ring, isize slot) -> std::array<isize, 3> {
    return {position_at(ring, slot - 1), position_at(ring, slot), position_at(ring, slot + 1)};
}

auto turn_at(const ear_ring& ring, isize slot) -> f32 {
    const vec2 corner = corner_at(ring, slot);
    return cross(corner - corner_at(ring, slot - 1), corner_at(ring, slot + 1) - corner);
}

auto is_flat(const ear_ring& ring, isize slot) -> bool {
    const vec2 corner = corner_at(ring, slot);
    const f32 sides =
        length(corner - corner_at(ring, slot - 1)) * length(corner_at(ring, slot + 1) - corner);
    return std::abs(turn_at(ring, slot)) <= straight_turn * sides;
}

// A clockwise corner whose triangle holds no other corner that could poke into it. Only a corner
// that does not turn clockwise can; one on top of the triangle's own corners is where the outline
// touches itself, and doesn't.
auto is_ear(const ear_ring& ring, isize slot) -> bool {
    if (turn_at(ring, slot) <= 0.0F) {
        return false;
    }
    const std::array<vec2, 3> ear{
        corner_at(ring, slot - 1),
        corner_at(ring, slot),
        corner_at(ring, slot + 1),
    };
    for (isize other = 2; other + 1 < std::ssize(ring.remaining); ++other) {
        const vec2 point = corner_at(ring, slot + other);
        const bool is_on_corner =
            std::ranges::any_of(ear, [point](vec2 corner) { return is_same_point(point, corner); });
        if (!is_on_corner && turn_at(ring, slot + other) <= 0.0F && is_inside(point, ear)) {
            return false;
        }
    }
    return true;
}

// An ear whose triangle stays upright on the inset corners. Any ear triangulates the outline, but
// a sliver beside a reflex corner can turn over once its corners move, and the body would lose it.
auto is_upright_ear(const ear_ring& ring, isize slot) -> bool {
    return doubled_area(inset_triangle(ring.view, ear_at(ring, slot))) > degenerate_area
           && is_ear(ring, slot);
}

struct ear_cut {
    isize slot = 0;
    // A corner that turns nowhere encloses nothing and is dropped without a triangle.
    bool is_enclosing = false;
};

// An ear, searched from the cursor, preferring one that stays upright inset. When there is none
// the outline is degenerate or crosses itself: a corner that turns nowhere goes, failing that any
// clockwise corner is cut, and a remainder that only turns the other way encloses nothing
// clockwise, so nothing is left to cut.
auto next_cut(const ear_ring& ring, isize cursor) -> std::optional<ear_cut> {
    const isize size = std::ssize(ring.remaining);
    for (isize step = 0; step < size; ++step) {
        const isize slot = (cursor + step) % size;
        if (is_upright_ear(ring, slot)) {
            return ear_cut{.slot = slot, .is_enclosing = true};
        }
    }
    for (isize slot = 0; slot < size; ++slot) {
        if (is_ear(ring, slot)) {
            return ear_cut{.slot = slot, .is_enclosing = true};
        }
    }
    for (isize slot = 0; slot < size; ++slot) {
        if (is_flat(ring, slot)) {
            return ear_cut{.slot = slot, .is_enclosing = false};
        }
    }
    for (isize slot = 0; slot < size; ++slot) {
        if (turn_at(ring, slot) > 0.0F) {
            return ear_cut{.slot = slot, .is_enclosing = true};
        }
    }
    return std::nullopt;
}

auto triangle_at(std::span<const isize> body, isize triangle) -> std::array<isize, 3> {
    const isize first = triangle * 3;
    return {element_at(body, first), element_at(body, first + 1), element_at(body, first + 2)};
}

auto put_triangle(std::span<isize> body, isize triangle, std::array<isize, 3> corners) -> void {
    std::ranges::copy(corners, body.subspan(narrow<usize>(triangle * 3), 3).begin());
}

// The triangle that has the edge from `tail` to `head` the other way round, and its corner off
// that edge.
struct neighbour {
    isize triangle = 0;
    isize far = 0;
};

auto neighbour_across(std::span<const isize> body, isize tail, isize head)
    -> std::optional<neighbour> {
    for (isize triangle = 0; triangle < std::ssize(body) / 3; ++triangle) {
        const std::array<isize, 3> corners = triangle_at(body, triangle);
        for (usize side = 0; side < corners.size(); ++side) {
            if (corners.at(side) == head && corners.at((side + 1) % 3) == tail) {
                return neighbour{.triangle = triangle, .far = corners.at((side + 2) % 3)};
            }
        }
    }
    return std::nullopt;
}

// Any ear clipping triangulates the outline, but a sliver along a reflex corner can turn over once
// its corners move inset, and some of them only the last ear can cut. Swapping the diagonal it
// shares with a neighbour, where both new triangles stand upright, usually rights it.
auto untangle(const fill_view& view, std::span<isize> body) -> void {
    for (isize triangle = 0; triangle < std::ssize(body) / 3; ++triangle) {
        const std::array<isize, 3> corners = triangle_at(body, triangle);
        for (usize side = 0; side < corners.size() && !is_upright(view, corners); ++side) {
            const isize tail = corners.at(side);
            const isize head = corners.at((side + 1) % 3);
            const isize opposite = corners.at((side + 2) % 3);
            const std::optional<neighbour> across = neighbour_across(body, tail, head);
            if (!across.has_value()) {
                continue;
            }
            const std::array<isize, 3> first{tail, across->far, opposite};
            const std::array<isize, 3> second{across->far, head, opposite};
            if (is_upright(view, first) && is_upright(view, second)) {
                put_triangle(body, triangle, first);
                put_triangle(body, across->triangle, second);
                break;
            }
        }
    }
}

}

auto path_builder::fill_convex(std::span<const vec2> outline, color tint)
    -> std::span<const path_vertex> {
    LUCENT_INVARIANT(std::ssize(outline) <= max_path_points);
    m_vertices.clear();
    take_outline(outline);
    if (m_order.size() < 3 || tint.a == 0) {
        return {};
    }
    inset_corners(outline);
    fan();
    untangle_body(outline);
    fill(outline, tint);
    return m_vertices;
}

auto path_builder::fill_polygon(std::span<const vec2> outline, color tint)
    -> std::span<const path_vertex> {
    LUCENT_INVARIANT(std::ssize(outline) <= max_path_points);
    m_vertices.clear();
    take_outline(outline);
    if (m_order.size() < 3 || tint.a == 0) {
        return {};
    }
    inset_corners(outline);
    clip_ears(outline);
    untangle_body(outline);
    fill(outline, tint);
    return m_vertices;
}

auto path_builder::stroke(const path_stroke& path) -> std::span<const path_vertex> {
    const isize given = std::ssize(path.points);
    LUCENT_INVARIANT(given <= max_path_points);
    LUCENT_INVARIANT(path.tints.empty() || std::ssize(path.tints) == given);
    LUCENT_INVARIANT(path.widths.empty() || std::ssize(path.widths) == given);
    m_vertices.clear();
    take_points(path.points, path.ends);
    const isize count = std::ssize(m_order);
    if (count < 2) {
        return {};
    }
    // Two points closed would be one segment drawn there and back.
    const bool is_loop = path.ends == path_end::closed && count >= 3;

    // An edge sharper than a pixel aliases, so the feather never narrows below one.
    const f32 feather = std::isfinite(path.feather) ? std::max(path.feather, 1.0F) : 1.0F;
    const auto point_at = [&](isize position) {
        const isize index = m_order.at(narrow<usize>(position % count));
        const f32 given_width = path.widths.empty() ? path.width : element_at(path.widths, index);
        const f32 width = std::isfinite(given_width) ? std::max(given_width, 0.0F) : 0.0F;
        const color tint = path.tints.empty() ? path.tint : element_at(path.tints, index);
        // Narrower than its feather, a stroke keeps the feather's profile and loses alpha instead,
        // so its coverage still adds up to its width.
        return stroke_point{
            .position = element_at(path.points, index),
            .core = std::max(width - feather, 0.0F) * 0.5F,
            .feather = feather,
            .tint = scaled_alpha(tint, std::min(width / feather, 1.0F)),
        };
    };

    const isize segments = is_loop ? count : count - 1;
    for (isize k = 0; k < segments; ++k) {
        stroke_segment(point_at(k), point_at(k + 1));
    }
    const isize first_join = is_loop ? 0 : 1;
    for (isize k = first_join; k < segments; ++k) {
        const stroke_point corner = point_at(k + count);
        stroke_join(
            corner,
            direction(point_at(k + count - 1).position, corner.position),
            direction(corner.position, point_at(k + 1).position)
        );
    }
    return m_vertices;
}

auto path_builder::take_points(std::span<const vec2> points, path_end ends) -> void {
    m_order.clear();
    if (!std::ranges::all_of(points, is_finite)) {
        return;
    }
    const auto kept = [&](isize slot) {
        return element_at(points, m_order.at(narrow<usize>(slot)));
    };
    for (const auto [index, point] : std::views::enumerate(points)) {
        if (m_order.empty() || !is_same_point(kept(std::ssize(m_order) - 1), point)) {
            m_order.push_back(index);
        }
    }
    while (ends == path_end::closed
           && m_order.size() > 1
           && is_same_point(kept(std::ssize(m_order) - 1), kept(0))) {
        m_order.pop_back();
    }
}

auto path_builder::take_outline(std::span<const vec2> outline) -> void {
    take_points(outline, path_end::closed);
    const fill_view view{.points = outline, .order = m_order, .inset = {}, .sharing = {}};
    f32 doubled = 0.0F;
    for (isize k = 0; k < std::ssize(m_order); ++k) {
        doubled += cross(point_at(view, k), point_at(view, k + 1));
    }
    if (doubled < 0.0F) {
        std::ranges::reverse(m_order);
    }
}

// Each corner moved half a pixel inward along its miter, before triangulating, so ear clipping can
// prefer ears that stay upright there.
auto path_builder::inset_corners(std::span<const vec2> outline) -> void {
    const fill_view view{.points = outline, .order = m_order, .inset = {}, .sharing = {}};
    m_inset.clear();
    for (isize k = 0; k < std::ssize(m_order); ++k) {
        const corner_points corner = corner_of(view, k);
        const vec2 arrival = direction(corner.before, corner.point);
        const vec2 departure = direction(corner.point, corner.after);
        const vec2 reach = miter(outward(arrival), outward(departure), arrival);
        m_inset.push_back(corner.point - (reach * half_fringe));
    }
    count_sharing(outline);
}

auto path_builder::count_sharing(std::span<const vec2> outline) -> void {
    const isize count = std::ssize(m_order);
    const fill_view view{.points = outline, .order = m_order, .inset = {}, .sharing = {}};
    m_sorted.clear();
    for (isize k = 0; k < count; ++k) {
        m_sorted.push_back(k);
    }
    std::ranges::sort(m_sorted, [&view](isize left, isize right) {
        const vec2 first = point_at(view, left);
        const vec2 second = point_at(view, right);
        return std::tie(first.x, first.y) < std::tie(second.x, second.y);
    });
    const auto sorted_point = [&](isize slot) {
        return point_at(view, m_sorted.at(narrow<usize>(slot)));
    };
    m_sharing.assign(narrow<usize>(count), 1);
    for (isize start = 0; start < count;) {
        isize end = start + 1;
        while (end < count && is_same_point(sorted_point(end), sorted_point(start))) {
            ++end;
        }
        for (isize k = start; k < end; ++k) {
            m_sharing.at(narrow<usize>(m_sorted.at(narrow<usize>(k)))) = end - start;
        }
        start = end;
    }
}

auto path_builder::fan() -> void {
    m_body.clear();
    for (isize k = 1; k + 1 < std::ssize(m_order); ++k) {
        m_body.insert(m_body.end(), {0, k, k + 1});
    }
}

auto path_builder::clip_ears(std::span<const vec2> outline) -> void {
    const fill_view view{
        .points = outline,
        .order = m_order,
        .inset = m_inset,
        .sharing = m_sharing,
    };
    m_body.clear();
    m_remaining.clear();
    for (isize k = 0; k < std::ssize(m_order); ++k) {
        m_remaining.push_back(k);
    }
    const auto cut_at = [&](isize slot) {
        const std::array<isize, 3> ear = ear_at({.view = view, .remaining = m_remaining}, slot);
        m_body.insert(m_body.end(), ear.begin(), ear.end());
    };
    isize cursor = 0;
    while (m_remaining.size() > 3) {
        const std::optional<ear_cut> cut =
            next_cut({.view = view, .remaining = m_remaining}, cursor);
        if (!cut.has_value()) {
            return;
        }
        if (cut->is_enclosing) {
            cut_at(cut->slot);
        }
        m_remaining.erase(m_remaining.begin() + cut->slot);
        // The corner before the cut one has a new neighbour, which makes it the likeliest ear.
        const isize size = std::ssize(m_remaining);
        cursor = (cut->slot + size - 1) % size;
    }
    if (turn_at({.view = view, .remaining = m_remaining}, 1) > 0.0F) {
        cut_at(1);
    }
}

auto path_builder::untangle_body(std::span<const vec2> outline) -> void {
    untangle({.points = outline, .order = m_order, .inset = m_inset, .sharing = m_sharing}, m_body);
}

// The body is m_body's triangles moved onto the corners inset half a pixel, and each edge gets a
// one-pixel band from the inset to as far outside, opaque to clear: they meet seamlessly, so the
// coverage adds up to the outline's area. A convex corner closes the gap its two bands leave with
// a fan round the corner.
auto path_builder::fill(std::span<const vec2> outline, color tint) -> void {
    fill_body(outline, tint);
    for (isize k = 0; k < std::ssize(m_order); ++k) {
        fill_band(outline, k, tint);
        fill_corner(outline, k, tint);
    }
}

// Where the outline is thinner than the fringe the inset folds and some triangles turn over.
// Those are dropped: a point the inset outline winds around once is covered by at least one
// upright triangle, since the overturned ones only cancel extra cover.
auto path_builder::fill_body(std::span<const vec2> outline, color tint) -> void {
    const fill_view view{
        .points = outline,
        .order = m_order,
        .inset = m_inset,
        .sharing = m_sharing,
    };
    for (isize triangle = 0; triangle < std::ssize(m_body) / 3; ++triangle) {
        const std::array<vec2, 3> moved = inset_triangle(view, triangle_at(m_body, triangle));
        if (doubled_area(moved) > degenerate_area) {
            add_triangle(
                {.position = moved.at(0), .tint = tint},
                {.position = moved.at(1), .tint = tint},
                {.position = moved.at(2), .tint = tint}
            );
        }
    }
}

// The band runs from the inset corners to their mirror images outside, except that outside a
// convex corner it stops square to its edge and the corner's fan takes over. Where the outline is
// thinner than the fringe that shape can fold; the band is then a plain rectangle across the edge
// with the kites a reflex corner needs, which overlap a little but never turn over.
auto path_builder::fill_band(std::span<const vec2> outline, isize position, color tint) -> void {
    const fill_view view{
        .points = outline,
        .order = m_order,
        .inset = m_inset,
        .sharing = m_sharing,
    };
    const color clear = with_alpha(tint, 0);
    const color edge = half_alpha(tint);
    const vec2 start = point_at(view, position);
    const vec2 end = point_at(view, position + 1);
    const vec2 out = outward(direction(start, end)) * half_fringe;
    const vec2 inner_start = inset_at(view, position);
    const vec2 inner_end = inset_at(view, position + 1);
    const bool is_reflex_start = turn_of(corner_of(view, position)) == corner_turn::reflex;
    const bool is_reflex_end = turn_of(corner_of(view, position + 1)) == corner_turn::reflex;
    const vec2 outer_start = is_reflex_start ? start + (start - inner_start) : start + out;
    const vec2 outer_end = is_reflex_end ? end + (end - inner_end) : end + out;
    const bool is_seamless = doubled_area(inner_start, outer_end, inner_end) > degenerate_area
                             && doubled_area(inner_start, outer_start, outer_end) > degenerate_area;
    if (is_seamless) {
        add_triangle(
            {.position = inner_start, .tint = tint},
            {.position = outer_end, .tint = clear},
            {.position = inner_end, .tint = tint}
        );
        add_triangle(
            {.position = inner_start, .tint = tint},
            {.position = outer_start, .tint = clear},
            {.position = outer_end, .tint = clear}
        );
        return;
    }
    add_triangle(
        {.position = start - out, .tint = tint},
        {.position = end + out, .tint = clear},
        {.position = end - out, .tint = tint}
    );
    add_triangle(
        {.position = start - out, .tint = tint},
        {.position = start + out, .tint = clear},
        {.position = end + out, .tint = clear}
    );
    if (is_reflex_start) {
        add_triangle(
            {.position = start, .tint = edge},
            {.position = start - out, .tint = tint},
            {.position = inner_start, .tint = tint}
        );
        add_triangle(
            {.position = start, .tint = edge},
            {.position = start + out, .tint = clear},
            {.position = outer_start, .tint = clear}
        );
    }
    if (is_reflex_end) {
        add_triangle(
            {.position = end, .tint = edge},
            {.position = inner_end, .tint = tint},
            {.position = end - out, .tint = tint}
        );
        add_triangle(
            {.position = end, .tint = edge},
            {.position = outer_end, .tint = clear},
            {.position = end + out, .tint = clear}
        );
    }
}

// Between the inset corner and the two bands' square ends, then round the outside, in two steps
// past a right angle. A corner that turns straight back is a convex one that turned half a circle.
auto path_builder::fill_corner(std::span<const vec2> outline, isize position, color tint) -> void {
    const fill_view view{
        .points = outline,
        .order = m_order,
        .inset = m_inset,
        .sharing = m_sharing,
    };
    const corner_points corner = corner_of(view, position);
    if (turn_of(corner) != corner_turn::convex) {
        return;
    }
    const vec2 arrival = direction(corner.before, corner.point);
    const vec2 before = outward(arrival);
    const vec2 after = outward(direction(corner.point, corner.after));
    const path_vertex centre{.position = corner.point, .tint = half_alpha(tint)};
    const path_vertex inner{.position = inset_at(view, position), .tint = tint};
    const auto rim = [&corner, tint](vec2 side) {
        return path_vertex{
            .position = corner.point + (side * half_fringe),
            .tint = with_alpha(tint, 0),
        };
    };
    add_triangle(inner, rim(before), centre);
    add_triangle(inner, centre, rim(after));
    if (dot(before, after) >= 0.0F) {
        add_triangle(centre, rim(before), rim(after));
        return;
    }
    const vec2 sum = before + after;
    const f32 reach = length(sum);
    const vec2 middle = reach > straight_turn ? sum * (1.0F / reach) : arrival;
    add_triangle(centre, rim(before), rim(middle));
    add_triangle(centre, rim(middle), rim(after));
}

// Three bands across the segment, each a trapezoid between the perpendiculars at its ends: clear
// to opaque, opaque, opaque to clear. A trapezoid never turns over, whatever the widths.
auto path_builder::stroke_segment(const stroke_point& start, const stroke_point& end) -> void {
    const vec2 side = outward(direction(start.position, end.position));
    const auto profile = [side](const stroke_point& point) {
        const color clear = with_alpha(point.tint, 0);
        const f32 outer = point.core + point.feather;
        return std::array<path_vertex, 4>{
            path_vertex{.position = point.position - (side * outer), .tint = clear},
            path_vertex{.position = point.position - (side * point.core), .tint = point.tint},
            path_vertex{.position = point.position + (side * point.core), .tint = point.tint},
            path_vertex{.position = point.position + (side * outer), .tint = clear},
        };
    };
    const std::array<path_vertex, 4> near = profile(start);
    const std::array<path_vertex, 4> far = profile(end);
    for (usize band = 0; band + 1 < near.size(); ++band) {
        add_triangle(near.at(band), far.at(band + 1), far.at(band));
        add_triangle(near.at(band), near.at(band + 1), far.at(band + 1));
    }
}

// The segments overlap inside the turn and leave a wedge outside it, swept clockwise from one
// segment's side to the other's and filled to the miter, or beveled past the limit. Straight on
// needs nothing; straight back leaves the two butt ends on top of each other.
auto path_builder::stroke_join(const stroke_point& corner, vec2 arrival, vec2 departure) -> void {
    const f32 turning = cross(arrival, departure);
    if (std::abs(turning) <= straight_turn) {
        return;
    }
    const vec2 first_side = turning > 0.0F ? outward(arrival) : outward(departure) * -1.0F;
    const vec2 last_side = turning > 0.0F ? outward(departure) : outward(arrival) * -1.0F;
    const f32 twice_cosine_squared = 1.0F + dot(first_side, last_side);
    const auto ring = [&corner](vec2 side, f32 reach, color tint) {
        return path_vertex{.position = corner.position + (side * reach), .tint = tint};
    };
    const color clear = with_alpha(corner.tint, 0);
    const f32 outer = corner.core + corner.feather;
    const vec2 tip = (first_side + last_side) * (1.0F / twice_cosine_squared);
    const std::array<vec2, 3> mitered{first_side, tip, last_side};
    const std::array<vec2, 2> beveled{first_side, last_side};
    const std::span<const vec2> sides = twice_cosine_squared * miter_limit * miter_limit >= 2.0F
                                            ? std::span<const vec2>{mitered}
                                            : std::span<const vec2>{beveled};
    const path_vertex centre{.position = corner.position, .tint = corner.tint};
    for (isize k = 0; k + 1 < std::ssize(sides); ++k) {
        const path_vertex inner_near = ring(element_at(sides, k), corner.core, corner.tint);
        const path_vertex inner_far = ring(element_at(sides, k + 1), corner.core, corner.tint);
        const path_vertex outer_near = ring(element_at(sides, k), outer, clear);
        const path_vertex outer_far = ring(element_at(sides, k + 1), outer, clear);
        add_triangle(centre, inner_near, inner_far);
        add_triangle(inner_near, outer_near, outer_far);
        add_triangle(inner_near, outer_far, inner_far);
    }
}

auto path_builder::add_triangle(path_vertex first, path_vertex second, path_vertex third) -> void {
    if (std::abs(doubled_area(first.position, second.position, third.position))
        <= degenerate_area) {
        return;
    }
    m_vertices.insert(m_vertices.end(), {first, second, third});
}

}
