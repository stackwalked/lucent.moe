#pragma once

#include <span>
#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw::detail {

// The most points one fill or stroke takes. Ear clipping is quadratic in them, and a caller with
// more is building geometry the draw list was never meant to carry.
inline constexpr isize max_path_points = 1024;

// Tessellates paths into triangle lists, coordinates in target pixels.
//
// Every emitted triangle is clockwise on screen (y down): cross(b - a, c - a) > 0. That holds for
// the antialiasing fringe as well as the body, so a triangle that comes out the other way round is
// a fold in the geometry, never a choice.
//
// Fills are antialiased by a one-pixel fringe centred on the true edge: opaque half a pixel inside
// it, transparent half a pixel outside, so the coverage adds up to the polygon's area. Strokes fade
// over their feather, never less than a pixel, centred on their edges the same way.
//
// Each call's result stays valid until the next call on the same builder.
class path_builder {
public:
    // The outline must be convex; it is fanned without a search. Either winding.
    auto fill_convex(std::span<const vec2> outline, color tint) -> std::span<const path_vertex>;

    // A simple outline, concave or touching itself, in either winding. A self-intersecting one
    // fills whatever the ear clipping finds.
    auto fill_polygon(std::span<const vec2> outline, color tint) -> std::span<const path_vertex>;

    // Joins are mitered up to a miter four times the stroke's half width, beveled past it; the
    // ends of an open path are butt. A stroke thinner than its feather fades instead of narrowing.
    auto stroke(const path_stroke& path) -> std::span<const path_vertex>;

private:
    // A point of a stroke and its cross-section there: opaque out to core either side of the
    // centre line, fading to nothing over the feather past it.
    struct stroke_point {
        vec2 position;
        f32 core = 0.0F;
        f32 feather = 1.0F;
        color tint;
    };

    auto take_points(std::span<const vec2> points, path_end ends) -> void;
    auto take_outline(std::span<const vec2> outline) -> void;
    auto clip_ears(std::span<const vec2> outline) -> void;
    auto untangle_body(std::span<const vec2> outline) -> void;
    auto fan() -> void;
    auto fill(std::span<const vec2> outline, color tint) -> void;
    auto inset_corners(std::span<const vec2> outline) -> void;
    auto count_sharing(std::span<const vec2> outline) -> void;
    auto fill_body(std::span<const vec2> outline, color tint) -> void;
    auto fill_band(std::span<const vec2> outline, isize position, color tint) -> void;
    auto fill_corner(std::span<const vec2> outline, isize position, color tint) -> void;
    auto stroke_segment(const stroke_point& start, const stroke_point& end) -> void;
    auto stroke_join(const stroke_point& corner, vec2 arrival, vec2 departure) -> void;
    auto add_triangle(path_vertex first, path_vertex second, path_vertex third) -> void;

    std::vector<path_vertex> m_vertices;
    // Indices into the caller's points with repeated points dropped; clockwise for a fill.
    std::vector<isize> m_order;
    // Positions into m_order: the corners ear clipping has not cut off yet.
    std::vector<isize> m_remaining;
    // Triangles of the body as positions into m_order, three per triangle.
    std::vector<isize> m_body;
    // Each outline corner moved half a pixel inward along its miter.
    std::vector<vec2> m_inset;
    // Per outline corner, how many corners share its point: more than one where the outline
    // touches itself.
    std::vector<isize> m_sharing;
    // Positions into m_order sorted by point, to find the shared ones.
    std::vector<isize> m_sorted;
};

}
