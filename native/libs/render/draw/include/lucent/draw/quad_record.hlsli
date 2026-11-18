// The quad record and its encodings, read by both C++ (lucent/draw/quad_record.hpp includes this
// inside a namespace that names float4, uint4 and uint) and the backend's shaders. Written in the
// syntax the two languages share: a struct of 16-byte vectors and static const integers, nothing
// else, so the layout and every number in it are defined once.
//
// Its fields are documented in quad_record.hpp.

#ifndef LUCENT_DRAW_QUAD_RECORD_HLSLI
#define LUCENT_DRAW_QUAD_RECORD_HLSLI

struct quad_record {
    float4 rect;
    float4 geometry;
    float4 gradient;
    uint4 style;
};

// The quad kinds, in style.z bits 0-3.
static const uint quad_kind_rounded_rect = 0;
static const uint quad_kind_arc = 1;
static const uint quad_kind_segment = 2;
static const uint quad_kind_atlas = 3;
static const uint quad_kind_image = 4;
static const uint quad_kind_mask = 0xf;

// The paint kinds, in style.z bits 4-6.
static const uint paint_kind_solid = 0;
static const uint paint_kind_linear = 1;
static const uint paint_kind_noise = 2;
static const uint paint_kind_shift = 4;
static const uint paint_kind_mask = 0x7;

// A round cap, style.z bit 7; bits 8-15 are reserved and zero; the atlas page is bits 16-31.
static const uint round_cap_bit = 0x80;
static const uint reserved_bits = 0xff00;
static const uint atlas_page_shift = 16;

// How far past its rect a record colours: reach_sigmas standard deviations of its softness, plus
// reach_pixels of antialiasing. The vertex shader grows the quad by exactly this.
static const uint reach_sigmas = 3;
static const uint reach_pixels = 1;

#endif
