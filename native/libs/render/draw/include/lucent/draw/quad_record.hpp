#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <utility>

#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/segment.hpp>

namespace lucent::draw {

namespace shared {

// The HLSL names quad_record.hlsli is written in.
using float4 = std::array<f32, 4>;
using uint4 = std::array<u32, 4>;
using uint = u32;

// The definition the shaders read too: one struct and its constants, so neither side can drift.
#include <lucent/draw/quad_record.hlsli>

}

enum class quad_kind : u8 {
    rounded_rect = shared::quad_kind_rounded_rect,
    arc = shared::quad_kind_arc,
    segment = shared::quad_kind_segment,
    // A coverage quad from the atlas texture array: a glyph or an icon.
    atlas = shared::quad_kind_atlas,
    // The run's bound image.
    image = shared::quad_kind_image,
};

// What a record is, packed into style[2]: bits 0-3 the quad kind, 4-6 the paint kind, 7 a round
// cap, 16-31 the atlas page. The rest stay zero.
struct record_kinds {
    quad_kind quad = quad_kind::rounded_rect;
    paint_kind paint = paint_kind::solid;
    cap ends = cap::butt;
    atlas_page page{};

    auto operator==(const record_kinds&) const -> bool = default;
};

constexpr auto pack(const record_kinds& kinds) -> u32 {
    return u32{std::to_underlying(kinds.quad)}
           | (u32{std::to_underlying(kinds.paint)} << shared::paint_kind_shift)
           | (kinds.ends == cap::round ? shared::round_cap_bit : 0U)
           | (u32{std::to_underlying(kinds.page)} << shared::atlas_page_shift);
}

// Absent when the bits name no kind or set a reserved bit.
constexpr auto unpack_kinds(u32 bits) -> std::optional<record_kinds> {
    const u32 quad = bits & shared::quad_kind_mask;
    const u32 paint = (bits >> shared::paint_kind_shift) & shared::paint_kind_mask;
    const bool has_reserved = (bits & shared::reserved_bits) != 0;
    if (quad > std::to_underlying(quad_kind::image)
        || paint > std::to_underlying(paint_kind::noise)
        || has_reserved) {
        return std::nullopt;
    }
    return record_kinds{
        .quad = static_cast<quad_kind>(quad),
        .paint = static_cast<paint_kind>(paint),
        .ends = (bits & shared::round_cap_bit) != 0 ? cap::round : cap::butt,
        .page = static_cast<atlas_page>(bits >> shared::atlas_page_shift),
    };
}

// One shape, glyph, icon or image quad: the instanced draw's whole input. The vertex shader builds
// the corners from SV_VertexID and grows rect by reach(softness); the pixel shader branches on the
// kind. Four 16-byte registers, which the backend's shader mirrors byte for byte.
//
//   rect      the shape's own rect in target pixels: min x, min y, max x, max y. Its centre is the
//             shape's centre for every kind.
//   geometry  rounded_rect  radii: top left, top right, bottom right, bottom left (clamped)
//             arc           radius to the band's centre, half band width, half sweep (0 to pi),
//                           the sweep's mid angle in [-pi, pi]: radians clockwise from +x on screen
//             segment       half the vector from start to end (x, y), half width, unused; a zero
//                           vector is a round-capped dot, never a direction to normalise
//             atlas, image  uv: min x, min y, max x, max y
//   gradient  linear paint: start x, y and end x, y in target pixels; otherwise zero
//   style     from colour, to colour (packed()), kinds (pack()), and softness (a Gaussian's
//             standard deviation; zero is a crisp antialiased edge) in the low half and stroke
//             width (zero fills) in the high half, both binary16
// The dialect bans using-declarations, so the shared struct gets its public name as an alias.
// NOLINTNEXTLINE(readability-redundant-qualified-alias): see above.
using quad_record = shared::quad_record;

static_assert(
    std::to_underlying(paint_kind::solid) == shared::paint_kind_solid
        && std::to_underlying(paint_kind::linear) == shared::paint_kind_linear
        && std::to_underlying(paint_kind::noise) == shared::paint_kind_noise,
    "paint_kind is the public spelling of the numbers the shader reads"
);

static_assert(sizeof(quad_record) == 64, "one record per instance in a 64-byte structured buffer");
static_assert(
    offsetof(quad_record, geometry) == 16
        && offsetof(quad_record, gradient) == 32
        && offsetof(quad_record, style) == 48,
    "each field is one 16-byte register"
);

// How far past its rect a record can colour, in pixels: three standard deviations of its blur and
// one pixel of antialiasing. The vertex shader grows the quad by the same amount.
constexpr auto reach(f32 softness) -> f32 {
    return (static_cast<f32>(shared::reach_sigmas) * softness)
           + static_cast<f32>(shared::reach_pixels);
}

}
