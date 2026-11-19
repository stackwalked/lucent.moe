#include <cmath>
#include <expected>
#include <optional>
#include <span>
#include <vector>

#include <dwrite_3.h>
#include <wrl/client.h>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

#include "direct_write.hpp"
#include "text_engine.hpp"

namespace lucent::text {
namespace {

using Microsoft::WRL::ComPtr;

// Horizontal subpixel positions a glyph is rasterized at: a pen lands on the nearest quarter.
constexpr i32 subpixel_phases = 4;

struct pen_position {
    f32 whole = 0.0F;
    u8 phase = 0;
};

auto split(f32 x) -> pen_position {
    const f32 steps = std::floor((x * subpixel_phases) + 0.5F);
    const f32 whole = std::floor(steps / subpixel_phases);
    return {
        .whole = whole,
        .phase = narrow<u8>(static_cast<i32>(steps - (whole * subpixel_phases))),
    };
}

auto uv_of(const draw::pixel_rect& area) -> draw::rect {
    return {
        .min = {.x = static_cast<f32>(area.left), .y = static_cast<f32>(area.top)},
        .max = {.x = static_cast<f32>(area.right), .y = static_cast<f32>(area.bottom)},
    };
}

auto layer_tint(std::optional<draw::color> layer, draw::color tint) -> draw::color {
    if (!layer) {
        return tint;
    }
    return draw::with_alpha(*layer, narrow<u8>(((u32{layer->a} * u32{tint.a}) + 127U) / 255U));
}

}

auto text_engine::draw(
    draw::draw_list& list, const text_layout& laid_out, draw::vec2 origin, draw::color tint
) -> result<void> {
    m_quads.clear();
    for (const placed_glyph& glyph : laid_out.glyphs) {
        const pen_position pen = split(glyph.pen.x);
        const glyph_entry* const entry = LUCENT_TRY(entry_for(
            {.face = glyph.face,
                .index = glyph.index,
                .em_size = glyph.em_size,
                .phase = pen.phase},
            raster_policy::budgeted
        ));
        if (entry == nullptr || !entry->slot) {
            continue;
        }
        const f32 left = pen.whole + static_cast<f32>(entry->bounds.left);
        const f32 top = glyph.pen.y + static_cast<f32>(entry->bounds.top);
        m_quads.push_back({
            .page = entry->slot->page,
            .bounds =
                {
                    .min = {.x = left, .y = top},
                    .max =
                        {
                            .x = left + static_cast<f32>(entry->bounds.right - entry->bounds.left),
                            .y = top + static_cast<f32>(entry->bounds.bottom - entry->bounds.top),
                        },
                },
            .uv = uv_of(entry->slot->area),
            .tint = layer_tint(glyph.layer_color, tint),
        });
    }
    list.draw(draw::glyph_run{.origin = origin, .glyphs = m_quads});
    return {};
}

auto text_engine::prewarm(const layout_request& request) -> result<void> {
    const text_layout* const laid_out = LUCENT_TRY(layout(request));
    for (const placed_glyph& glyph : laid_out->glyphs) {
        LUCENT_TRY(entry_for(
            {
                .face = glyph.face,
                .index = glyph.index,
                .em_size = glyph.em_size,
                .phase = split(glyph.pen.x).phase,
            },
            raster_policy::unbudgeted
        ));
    }
    return {};
}

auto text_engine::add_icon(const icon_pixels& pixels) -> result<icon> {
    LUCENT_INVARIANT(pixels.size.width > 0 && pixels.size.height > 0);
    const std::optional<atlas_slot> slot = m_atlas.allocate(pixels.size, atlas_lifetime::pinned);
    if (!slot) {
        // Larger than a page, or the pinned pages are full: the icon set doesn't fit this atlas.
        return std::unexpected(error{.code = error_code::unsupported, .system_code = 0});
    }
    m_atlas.write(*slot, pixels.coverage, pixels.row_pitch);
    return icon{.page = slot->page, .uv = uv_of(slot->area), .size = pixels.size};
}

auto text_engine::draw(
    draw::draw_list& list, const icon& drawn, draw::vec2 origin, draw::color tint
) -> void {
    m_atlas.touch(drawn.page);
    const draw::glyph_quad quad{
        .page = drawn.page,
        .bounds =
            {
                .min = {.x = 0.0F, .y = 0.0F},
                .max =
                    {
                        .x = static_cast<f32>(drawn.size.width),
                        .y = static_cast<f32>(drawn.size.height),
                    },
            },
        .uv = drawn.uv,
        .tint = tint,
    };
    list.draw(draw::glyph_run{.origin = origin, .glyphs = {&quad, 1}});
}

auto text_engine::entry_for(const glyph_key& key, raster_policy policy)
    -> result<const glyph_entry*> {
    if (const auto found = m_glyphs.find(key); found != m_glyphs.end()) {
        const glyph_entry& entry = found->second;
        if (!entry.slot) {
            return &entry;
        }
        if (m_atlas.is_current(*entry.slot)) {
            m_atlas.touch(entry.slot->page);
            return &entry;
        }
    }
    if (policy == raster_policy::budgeted && m_rasterized >= m_options.raster_budget) {
        return nullptr;
    }
    ++m_rasterized;
    const std::optional<glyph_entry> made = LUCENT_TRY(rasterize(key));
    if (!made) {
        return nullptr;
    }
    const auto [placed, _] = m_glyphs.insert_or_assign(key, *made);
    return &placed->second;
}

// Hinted grayscale coverage: NATURAL_SYMMETRIC hints vertically only, which keeps the subpixel
// phases distinct, and grayscale antialiasing blends over any background where ClearType can't.
auto text_engine::rasterize(const glyph_key& key) -> result<std::optional<glyph_entry>> {
    const u16 index = key.index;
    const f32 advance = 0.0F;
    const DWRITE_GLYPH_OFFSET offset{};
    const DWRITE_GLYPH_RUN run{
        .fontFace = face(key.face).face.Get(),
        .fontEmSize = key.em_size,
        .glyphCount = 1,
        .glyphIndices = &index,
        .glyphAdvances = &advance,
        .glyphOffsets = &offset,
        .isSideways = FALSE,
        .bidiLevel = 0,
    };
    ComPtr<IDWriteGlyphRunAnalysis> analysis;
    LUCENT_TRY(checked(m_factory->CreateGlyphRunAnalysis(
        &run,
        nullptr,
        DWRITE_RENDERING_MODE_NATURAL_SYMMETRIC,
        DWRITE_MEASURING_MODE_NATURAL,
        DWRITE_GRID_FIT_MODE_ENABLED,
        DWRITE_TEXT_ANTIALIAS_MODE_GRAYSCALE,
        static_cast<f32>(key.phase) / subpixel_phases,
        0.0F,
        &analysis
    )));
    // With grayscale antialiasing the 1x1 texture holds 8-bit coverage, not aliased bits.
    RECT ink{};
    LUCENT_TRY(checked(analysis->GetAlphaTextureBounds(DWRITE_TEXTURE_ALIASED_1x1, &ink)));
    const draw::pixel_rect bounds{
        .left = narrow<i32>(ink.left),
        .top = narrow<i32>(ink.top),
        .right = narrow<i32>(ink.right),
        .bottom = narrow<i32>(ink.bottom),
    };
    const draw::pixel_size size{
        .width = bounds.right - bounds.left,
        .height = bounds.bottom - bounds.top,
    };
    if (size.width <= 0 || size.height <= 0) {
        return glyph_entry{.bounds = bounds, .slot = std::nullopt};
    }
    const std::optional<atlas_slot> slot = m_atlas.allocate(size, atlas_lifetime::evictable);
    if (!slot) {
        return std::nullopt;
    }
    m_raster_scratch.resize(narrow<usize>(isize{size.width} * size.height));
    LUCENT_TRY(checked(analysis->CreateAlphaTexture(
        DWRITE_TEXTURE_ALIASED_1x1,
        &ink,
        m_raster_scratch.data(),
        narrow<UINT32>(std::ssize(m_raster_scratch))
    )));
    m_atlas.write(*slot, std::as_bytes(std::span{m_raster_scratch}), size.width);
    return glyph_entry{.bounds = bounds, .slot = slot};
}

}
