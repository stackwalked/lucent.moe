#pragma once

#include <lucent/draw/rect.hpp>

namespace lucent::draw {

struct corners {
    f32 top_left = 0.0F;
    f32 top_right = 0.0F;
    f32 bottom_right = 0.0F;
    f32 bottom_left = 0.0F;
};

constexpr auto uniform(f32 radius) -> corners {
    return {.top_left = radius, .top_right = radius, .bottom_right = radius, .bottom_left = radius};
}

// Radii are clamped to half the shorter side where it is drawn, so an oversized radius makes a pill
// rather than an inverted shape.
struct rounded_rect {
    rect bounds;
    corners radii;
};

}
