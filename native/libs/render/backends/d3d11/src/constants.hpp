#pragma once

#include <array>
#include <cstddef>

namespace lucent::d3d11 {

namespace shared {

// The HLSL names constants.hlsli is written in.
using float4 = std::array<f32, 4>;
using uint = u32;

// The definitions the shaders read too: neither side can drift.
#include "shaders/constants.hlsli"

}

// The dialect bans using-declarations, so the shared structs get their names here as aliases.
// NOLINTBEGIN(readability-redundant-qualified-alias): see above.
using frame_constants = shared::frame_constants;
using mask_constants = shared::mask_constants;
using pass_constants = shared::pass_constants;
// NOLINTEND(readability-redundant-qualified-alias)

static_assert(sizeof(frame_constants) == 16, "one register");

static_assert(sizeof(mask_constants) == 16 + (usize{32} * shared::max_masks), "16-byte elements");
static_assert(
    offsetof(mask_constants, rects) == 16
        && offsetof(mask_constants, radii) == 16 + (usize{16} * shared::max_masks),
    "every array element is one register on both sides"
);

static_assert(sizeof(pass_constants) == usize{7} * 16, "seven registers");
static_assert(
    offsetof(pass_constants, rect) == 16
        && offsetof(pass_constants, mapping) == 32
        && offsetof(pass_constants, limit) == 48
        && offsetof(pass_constants, filter) == 64
        && offsetof(pass_constants, layer) == 80
        && offsetof(pass_constants, bounds) == 96,
    "each field is one register"
);

}
