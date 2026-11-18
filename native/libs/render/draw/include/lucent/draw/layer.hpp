#pragma once

#include <optional>

#include <lucent/draw/rect.hpp>

namespace lucent::draw {

// Names a layer's sampled light, so the backend's readback can say which layer a value came from.
enum class light_key : u32 {};

// A surface: the draws inside it composite as one over what is already there, clipped to bounds
// and masked to radius (a rounded clip is a layer). Only blur and opacity below one cost the
// backend a pass; tint, grain and highlights are ordinary draws inside it.
struct layer {
    rect bounds;
    f32 radius = 0.0F;
    // Below one, the contents render aside and composite back at this alpha, so overlapping
    // children fade as one surface.
    f32 opacity = 1.0F;
    // The backdrop behind the bounds, blurred by a Gaussian of this standard deviation, is the
    // first thing in the layer.
    f32 blur = 0.0F;
    // A band this wide along the edge where the backdrop is sampled from a little outside it, the
    // way a bevel bends light. Needs blur.
    f32 rim = 0.0F;
    // When set, the blurred backdrop is averaged now and then and reported under this key, for the
    // theme to read as the light behind the layer. Needs blur.
    std::optional<light_key> light = std::nullopt;
};

}
