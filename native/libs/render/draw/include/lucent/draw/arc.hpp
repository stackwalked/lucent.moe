#pragma once

#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

// A circular arc, only ever stroked, with round ends. Angles are radians clockwise from +x on
// screen (y grows downward); a positive sweep runs clockwise.
struct arc {
    vec2 centre;
    f32 radius = 0.0F;
    f32 start = 0.0F;
    f32 sweep = 0.0F;
};

}
