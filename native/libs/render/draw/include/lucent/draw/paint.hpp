#pragma once

#include <lucent/draw/color.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::draw {

// The record keeps three bits for it, so radial and conic fit when something needs them.
enum class paint_kind : u8 {
    solid,
    // from at start, to at end, along the line between them.
    linear,
    // from at a per-pixel random fraction of its alpha: grain that stays under the pixel rather
    // than shimmering per frame.
    noise,
};

// What a shape is filled with. Gradient points are in the same space the shape is given in.
struct paint {
    paint_kind kind = paint_kind::solid;
    color from;
    color to;
    vec2 start;
    vec2 end;
};

constexpr auto solid(color tint) -> paint {
    return {
        .kind = paint_kind::solid,
        .from = tint,
        .to = tint,
        .start = {.x = 0.0F, .y = 0.0F},
        .end = {.x = 0.0F, .y = 0.0F},
    };
}

constexpr auto noise(color tint) -> paint {
    return {
        .kind = paint_kind::noise,
        .from = tint,
        .to = tint,
        .start = {.x = 0.0F, .y = 0.0F},
        .end = {.x = 0.0F, .y = 0.0F},
    };
}

constexpr auto is_invisible(const paint& fill) -> bool {
    return fill.from.a == 0 && fill.to.a == 0;
}

}
