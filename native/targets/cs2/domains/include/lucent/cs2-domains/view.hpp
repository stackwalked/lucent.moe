#pragma once

#include <array>
#include <optional>

#include <lucent/cs2-domains/foreign/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::cs2 {

// The camera as one frame left it: world space to clip space, row-major, rows x, y, z, w.
struct view {
    using backing = foreign::view;

    std::array<std::array<f32, 4>, 4> to_clip{};
};

// Where point lands on a screen of that size, y down; empty behind the camera.
auto project(const view& camera, vec3 point, draw::vec2 screen) -> std::optional<draw::vec2>;

// Empty when the matrix doesn't hold up: a value that isn't finite, or all zero (no view yet).
auto read_view(const kit::read_access<foreign::view>& game) -> std::optional<view>;

}
