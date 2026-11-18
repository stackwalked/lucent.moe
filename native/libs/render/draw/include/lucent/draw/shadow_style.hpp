#pragma once

#include <lucent/draw/color.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

// A soft copy of a shape under it: spread grows the shape, offset moves it, then a Gaussian of blur
// (its standard deviation) softens it.
struct shadow_style {
    color tint;
    f32 blur = 8.0F;
    f32 spread = 0.0F;
    vec2 offset;
};

}
