#pragma once

#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>

namespace lucent::draw {

// An image the backend owns. The value is the backend's slot and serial; the draw list only
// carries it, and a stale one draws nothing.
enum class image_handle : u64 {};

struct image_quad {
    image_handle image{};
    rect bounds;
    rect uv{.min = {.x = 0.0F, .y = 0.0F}, .max = {.x = 1.0F, .y = 1.0F}};
    color tint = white;
};

}
