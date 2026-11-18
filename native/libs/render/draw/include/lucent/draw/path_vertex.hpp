#pragma once

#include <lucent/draw/color.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

// One corner of a tessellated triangle, in target pixels. Paths are antialiased by a fringe of
// triangles whose outer corners are transparent, so the colour carries the coverage.
struct path_vertex {
    vec2 position;
    color tint;

    auto operator==(const path_vertex&) const -> bool = default;
};

static_assert(sizeof(path_vertex) == 12, "the path vertex buffer's stride: float2 then R8G8B8A8");

}
