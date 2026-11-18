#pragma once

#include <span>

#include <lucent/draw/color.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

enum class path_end : u8 { open, closed };

// A polyline stroked centred on its points. tints and widths are either empty, for tint and width
// at every point, or one per point, blended along each segment: a path that fades or tapers.
// feather is how far the edge fades, in the same measure as width; a feather as wide as the stroke
// fades all the way from its centre line.
struct path_stroke {
    std::span<const vec2> points;
    std::span<const color> tints;
    std::span<const f32> widths;
    color tint = white;
    f32 width = 1.0F;
    f32 feather = 1.0F;
    path_end ends = path_end::open;
};

}
