#pragma once

#include <lucent/draw/rect.hpp>

namespace lucent::draw {

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
    // The blurred backdrop is averaged now and then for the theme to read as the light behind the
    // layer. Needs blur.
    bool should_sample_light = false;
};

}
