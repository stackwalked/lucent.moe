// What every program shares: the bindings, the interpolants and the colour helpers. HLSL only; what
// C++ also reads is in constants.hlsli and draw's quad_record.hlsli.

#ifndef LUCENT_D3D11_INTERFACE_HLSLI
#define LUCENT_D3D11_INTERFACE_HLSLI

#include "constants.hlsli"
#include <lucent/draw/quad_record.hlsli>

cbuffer frame_buffer : register(b0) {
    frame_constants frame;
};

cbuffer mask_buffer : register(b1) {
    mask_constants masks;
};

cbuffer pass_buffer : register(b2) {
    pass_constants passing;
};

StructuredBuffer<quad_record> records : register(t0);
// The atlas pages: A8 coverage, one slice a page.
Texture2DArray<float> atlas : register(t1);
// The run's image: premultiplied sRGB.
Texture2D<float4> image : register(t2);
// A pass's source: a backdrop being blurred, or a layer's contents.
Texture2D<float4> source : register(t3);
SamplerState linear_clamp : register(s0);

// Every vertex shader writes this and every pixel shader reads it, so no signature can drift.
struct pixel_input {
    float4 position : SV_Position;
    // The pixel's position in the space the draw is given in: target pixels for records, paths and
    // composites, the scratch surface's for a blur step. Not SV_Position: a layer drawn aside
    // renders into a surface offset from the target.
    float2 pixel : PIXEL;
    // A path vertex's straight sRGB colour, its alpha carrying coverage.
    float4 color : COLOR;
    nointerpolation uint record : RECORD;
};

// Clip space from a position in a space of the given size, y down.
float4 clip_position(float2 position, float2 space) {
    float2 ndc = position / space * float2(2.0f, -2.0f) + float2(-1.0f, 1.0f);
    return float4(ndc, 0.0f, 1.0f);
}

float4 unpack_color(uint value) {
    return float4(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >> 24) / 255.0f;
}

float4 premultiplied(float4 straight) {
    return float4(straight.rgb * straight.a, straight.a);
}

float3 linear_from_srgb(float3 encoded) {
    float3 low = encoded / 12.92f;
    float3 high = pow(max((encoded + 0.055f) / 1.055f, 0.0f), 2.4f);
    return float3(
        encoded.r <= 0.04045f ? low.r : high.r,
        encoded.g <= 0.04045f ? low.g : high.g,
        encoded.b <= 0.04045f ? low.b : high.b
    );
}

// The distance from p to a box of the given half size centred on the origin, its corners rounded
// by radii (top left, top right, bottom right, bottom left; y grows downward). Negative inside.
float rounded_box(float2 p, float2 half_size, float4 radii) {
    float radius = p.x < 0.0f ? (p.y < 0.0f ? radii.x : radii.w) : (p.y < 0.0f ? radii.y : radii.z);
    float2 q = abs(p) - half_size + radius;
    return length(max(q, 0.0f)) + min(max(q.x, q.y), 0.0f) - radius;
}

// The open rounded layers' corners, cut wherever something lands in target pixels: a rounded clip
// costs no pass of its own, and a nested layer's composite stays inside its parents.
float mask_of(float2 pixel) {
    float coverage = 1.0f;
    uint count = (uint)masks.count.x;
    for (uint i = 0; i < count; ++i) {
        float4 rect = masks.rects[i];
        float2 centre = (rect.xy + rect.zw) * 0.5f;
        float2 half_size = (rect.zw - rect.xy) * 0.5f;
        float distance = rounded_box(pixel - centre, half_size, masks.radii[i].xxxx);
        coverage *= saturate(0.5f - distance);
    }
    return coverage;
}

#endif
