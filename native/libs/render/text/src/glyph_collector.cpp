#include <bit>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <dwrite_3.h>

#include <lucent/core/narrow.hpp>
#include <lucent/draw/vec2.hpp>

#include "direct_write.hpp"

namespace lucent::text {

auto checked(HRESULT code) -> result<void> {
    if (FAILED(code)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = std::bit_cast<u32>(code)}
        );
    }
    return {};
}

auto copied_run(
    const DWRITE_GLYPH_RUN& run, const DWRITE_GLYPH_RUN_DESCRIPTION* description, draw::vec2 origin
) -> collected_run {
    const auto count = narrow<usize>(run.glyphCount);
    collected_run collected{
        .face = run.fontFace,
        .em_size = run.fontEmSize,
        .origin = origin,
        .bidi_level = run.bidiLevel,
        .glyphs = {},
        .advances = {},
        .offsets = {},
        .cluster_map = {},
        .text_position = 0,
    };
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // sized by DirectWrite's run
    collected.glyphs.assign_range(std::span{run.glyphIndices, count});
    if (run.glyphAdvances != nullptr) {
        collected.advances.assign_range(std::span{run.glyphAdvances, count});
    } else {
        collected.advances.assign(count, 0.0F);
    }
    if (run.glyphOffsets != nullptr) {
        collected.offsets.assign_range(std::span{run.glyphOffsets, count});
    } else {
        collected.offsets.assign(count, DWRITE_GLYPH_OFFSET{});
    }
    if (description != nullptr && description->clusterMap != nullptr) {
        collected.cluster_map.assign_range(
            std::span{description->clusterMap, narrow<usize>(description->stringLength)}
        );
        collected.text_position = description->textPosition;
    }
#pragma clang diagnostic pop
    return collected;
}

auto glyph_collector::take_runs() -> std::vector<collected_run> {
    return std::exchange(m_runs, {});
}

auto glyph_collector::QueryInterface(const IID& interface_id, void** object) noexcept -> HRESULT {
    if (object == nullptr) {
        return E_POINTER;
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // COM names interfaces by __uuidof
    const bool is_ours = interface_id == __uuidof(IUnknown)
                         || interface_id == __uuidof(IDWritePixelSnapping)
                         || interface_id == __uuidof(IDWriteTextRenderer);
#pragma clang diagnostic pop
    if (is_ours) {
        *object = static_cast<IDWriteTextRenderer*>(this);
        return S_OK;
    }
    *object = nullptr;
    return E_NOINTERFACE;
}

auto glyph_collector::AddRef() noexcept -> ULONG {
    return 1;
}

auto glyph_collector::Release() noexcept -> ULONG {
    return 1;
}

auto glyph_collector::IsPixelSnappingDisabled(void* /*context*/, BOOL* is_disabled) noexcept
    -> HRESULT {
    *is_disabled = TRUE;
    return S_OK;
}

auto glyph_collector::GetCurrentTransform(void* /*context*/, DWRITE_MATRIX* transform) noexcept
    -> HRESULT {
    *transform = {.m11 = 1.0F, .m12 = 0.0F, .m21 = 0.0F, .m22 = 1.0F, .dx = 0.0F, .dy = 0.0F};
    return S_OK;
}

auto glyph_collector::GetPixelsPerDip(void* /*context*/, FLOAT* pixels_per_dip) noexcept
    -> HRESULT {
    *pixels_per_dip = 1.0F;
    return S_OK;
}

// Copying the run allocates, and an allocation failure ends the process: no exception reaches
// DirectWrite.
// NOLINTNEXTLINE(bugprone-exception-escape): see above.
auto glyph_collector::DrawGlyphRun(
    void* /*context*/,
    FLOAT origin_x,
    FLOAT origin_y,
    DWRITE_MEASURING_MODE /*measuring_mode*/,
    const DWRITE_GLYPH_RUN* run,
    const DWRITE_GLYPH_RUN_DESCRIPTION* description,
    IUnknown* /*effect*/
) noexcept -> HRESULT {
    collected_run collected = copied_run(*run, description, {.x = origin_x, .y = origin_y});
    if (m_is_in_inline_object) {
        // The trimming sign's own text, not the layout's.
        collected.cluster_map.clear();
        collected.text_position = 0;
    }
    m_runs.push_back(std::move(collected));
    return S_OK;
}

auto glyph_collector::DrawUnderline(
    void* /*context*/,
    FLOAT /*origin_x*/,
    FLOAT /*origin_y*/,
    const DWRITE_UNDERLINE* /*underline*/,
    IUnknown* /*effect*/
) noexcept -> HRESULT {
    return S_OK;
}

auto glyph_collector::DrawStrikethrough(
    void* /*context*/,
    FLOAT /*origin_x*/,
    FLOAT /*origin_y*/,
    const DWRITE_STRIKETHROUGH* /*strikethrough*/,
    IUnknown* /*effect*/
) noexcept -> HRESULT {
    return S_OK;
}

// The trimming sign is an inline object that draws its ellipsis through the renderer it is given.
auto glyph_collector::DrawInlineObject(
    void* context,
    FLOAT origin_x,
    FLOAT origin_y,
    IDWriteInlineObject* inline_object,
    BOOL is_sideways,
    BOOL is_right_to_left,
    IUnknown* effect
) noexcept -> HRESULT {
    m_is_in_inline_object = true;
    const HRESULT drawn = inline_object->Draw(
        context, this, origin_x, origin_y, is_sideways, is_right_to_left, effect
    );
    m_is_in_inline_object = false;
    return drawn;
}

}
