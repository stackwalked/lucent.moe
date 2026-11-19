#include <lucent/cs2-domains/view.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>

#include <lucent/cs2-domains/foreign/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::cs2 {
namespace {

// A point this close to the camera plane, or behind it, has no place on screen.
constexpr f32 nearest_w = 0.001F;

using row = std::array<f32, 4>;

auto applied(const row& factors, vec3 point) -> f32 {
    return (factors[0] * point.x) + (factors[1] * point.y) + (factors[2] * point.z) + factors[3];
}

auto is_finite(const row& values) -> bool {
    return std::ranges::all_of(values, [](f32 value) { return std::isfinite(value); });
}

auto is_zero(const row& values) -> bool {
    return std::ranges::all_of(values, [](f32 value) { return value == 0.0F; });
}

}

// Clip space as D3D's: x and y in -1..1 across the screen after dividing by w, y up.
// build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44)
// found: view.cpp's setup passes the global as its world-to-projection output (the view_matrix
// finders); rows x, y, z, w as old lucent projected with it
// breaks: boxes mirrored, stretched or off screen
auto project(const view& camera, vec3 point, draw::vec2 screen) -> std::optional<draw::vec2> {
    const f32 w = applied(camera.to_clip[3], point);
    if (w < nearest_w) {
        return std::nullopt;
    }
    const f32 x = applied(camera.to_clip[0], point) / w;
    const f32 y = applied(camera.to_clip[1], point) / w;
    return draw::vec2{
        .x = screen.x * 0.5F * (1.0F + x),
        .y = screen.y * 0.5F * (1.0F - y),
    };
}

auto read_view(const kit::read_access<foreign::view>& game) -> std::optional<view> {
    const result<foreign::matrix> held = game.read<foreign::view_matrix>();
    if (!held) {
        return std::nullopt;
    }
    if (!std::ranges::all_of(*held, is_finite) || std::ranges::all_of(*held, is_zero)) {
        return std::nullopt;
    }
    return view{.to_clip = *held};
}

}
