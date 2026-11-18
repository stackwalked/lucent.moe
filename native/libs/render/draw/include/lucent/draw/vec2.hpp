#pragma once

namespace lucent::draw {

// A point or offset in the plane. On a draw list's input it is in units, everywhere after in target
// pixels; y grows downward.
struct vec2 {
    f32 x = 0.0F;
    f32 y = 0.0F;

    auto operator==(const vec2&) const -> bool = default;

    friend constexpr auto operator+(vec2 left, vec2 right) -> vec2 {
        return {.x = left.x + right.x, .y = left.y + right.y};
    }

    friend constexpr auto operator-(vec2 left, vec2 right) -> vec2 {
        return {.x = left.x - right.x, .y = left.y - right.y};
    }

    friend constexpr auto operator*(vec2 point, f32 factor) -> vec2 {
        return {.x = point.x * factor, .y = point.y * factor};
    }
};

constexpr auto dot(vec2 left, vec2 right) -> f32 {
    return (left.x * right.x) + (left.y * right.y);
}

// The z of the 3D cross product: positive when right turns clockwise from left on screen.
constexpr auto cross(vec2 left, vec2 right) -> f32 {
    return (left.x * right.y) - (left.y * right.x);
}

}
