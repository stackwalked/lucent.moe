// Every constant buffer the backend's shaders read, defined once for HLSL and C++ (src/constants.hpp
// includes this inside a namespace that names float4 and uint). Only 16-byte vectors, so neither
// side can pad differently; old lucent's first blur never blurred because a cbuffer array was
// strided 16 bytes in HLSL and 8 in C++. C++ static_asserts every size and offset.

#ifndef LUCENT_D3D11_CONSTANTS_HLSLI
#define LUCENT_D3D11_CONSTANTS_HLSLI

// b0, set once a frame, read by the quad and path vertex shaders and the main pixel shader.
struct frame_constants {
    // The target's width and height in pixels; z is 1 when the target takes linear values (its
    // view encodes sRGB, or it is scRGB); w is what white is worth there: 1, or scRGB's paper white.
    float4 target;
};

// The most rounded layers that can be open at once: draw_list's layer depth.
static const uint max_masks = 8;

// b1, the rounded layers open around a draw, innermost last. Their rects are already scissored;
// the shader cuts their corners.
struct mask_constants {
    // x is how many masks apply; yzw are unused.
    float4 count;
    // The layer's bounds in target pixels: min x, min y, max x, max y.
    // HLSL has no std::array, and arrays of float4 stride 16 bytes on both sides.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): see above.
    float4 rects[max_masks];
    // x is the corner radius; yzw are unused.
    // NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): see above.
    float4 radii[max_masks];
};

// The longest a blur pass's kernel reaches, in texels either side; wider blurs downsample first.
static const uint max_blur_radius = 24;

// b2, one full-surface pass: a blur step, a downsample, a composite or the light probe.
struct pass_constants {
    // The width and height of the space rect is in; zw are unused.
    float4 space;
    // The rect the pass covers, in that space: min x, min y, max x, max y.
    float4 rect;
    // A pixel's position in that space to the source's uv: uv = position * xy + zw.
    float4 mapping;
    // The source's uv clamp, half a texel inside what was written: min x, min y, max x, max y.
    float4 limit;
    // A blur step: the uv of one texel along the blur's axis (x, y), the Gaussian's standard
    // deviation in texels, and how many texels either side it reaches.
    float4 filter;
    // A composite: the layer's corner radius, rim width, opacity, and 1 when the source is a
    // backdrop (opaque where it is seen) rather than the layer's own contents.
    float4 layer;
    // A composite: the layer's bounds in the space's pixels.
    float4 bounds;
};

// The path vertex shader's record index: the main pixel shader reads the vertex colour instead.
static const uint path_record = 0xffffffff;

#endif
