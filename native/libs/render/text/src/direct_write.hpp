#pragma once

#include <string>
#include <vector>

#include <dwrite_3.h>
#include <wrl/client.h>

#include <lucent/draw/vec2.hpp>

namespace lucent::text {

// An HRESULT as a result: a failure carries it as the system code.
auto checked(HRESULT code) -> result<void>;

// One glyph run as IDWriteTextLayout::Draw handed it over, copied out of the call.
struct collected_run {
    Microsoft::WRL::ComPtr<IDWriteFontFace> face;
    f32 em_size = 0.0F;
    draw::vec2 origin;
    u32 bidi_level = 0;
    std::vector<u16> glyphs;
    std::vector<f32> advances;
    std::vector<DWRITE_GLYPH_OFFSET> offsets;
    // From the run's description: per UTF-16 unit of [text_position, text_position + length),
    // the index of the first glyph of its cluster. Empty for a run with no text behind it (the
    // trimming sign's ellipsis).
    std::vector<u16> cluster_map;
    u32 text_position = 0;
};

// Copies a run DirectWrite lends for one call. Its arrays are as long as its glyph count, and the
// description's cluster map as its string length: DirectWrite's contract, as no span can say.
auto copied_run(
    const DWRITE_GLYPH_RUN& run, const DWRITE_GLYPH_RUN_DESCRIPTION* description, draw::vec2 origin
) -> collected_run;

// The renderer IDWriteTextLayout::Draw calls: it keeps every glyph run, drawing nothing. Pixel
// snapping is off (one DIP is one pixel), so pens keep their fractional x for the subpixel phases.
//
// It lives on the stack for one Draw call, which holds no reference past returning, so its
// reference count is a constant rather than an owner. x64 only: STDMETHODCALLTYPE is left out of
// the overrides, as it means nothing there.
class glyph_collector final : public IDWriteTextRenderer {
public:
    glyph_collector() = default;
    glyph_collector(const glyph_collector&) = delete ("DirectWrite holds its address during Draw");
    auto operator=(const glyph_collector&)
        -> glyph_collector& = delete ("DirectWrite holds its address during Draw");
    glyph_collector(glyph_collector&&) = delete ("DirectWrite holds its address during Draw");
    auto operator=(glyph_collector&&)
        -> glyph_collector& = delete ("DirectWrite holds its address during Draw");
    ~glyph_collector() = default;

    auto take_runs() -> std::vector<collected_run>;

    auto QueryInterface(const IID& interface_id, void** object) noexcept -> HRESULT override;
    auto AddRef() noexcept -> ULONG override;
    auto Release() noexcept -> ULONG override;

    auto IsPixelSnappingDisabled(void* context, BOOL* is_disabled) noexcept -> HRESULT override;
    auto GetCurrentTransform(void* context, DWRITE_MATRIX* transform) noexcept -> HRESULT override;
    auto GetPixelsPerDip(void* context, FLOAT* pixels_per_dip) noexcept -> HRESULT override;

    auto DrawGlyphRun(
        void* context,
        FLOAT origin_x,
        FLOAT origin_y,
        DWRITE_MEASURING_MODE measuring_mode,
        const DWRITE_GLYPH_RUN* run,
        const DWRITE_GLYPH_RUN_DESCRIPTION* description,
        IUnknown* effect
    ) noexcept -> HRESULT override;
    auto DrawUnderline(
        void* context,
        FLOAT origin_x,
        FLOAT origin_y,
        const DWRITE_UNDERLINE* underline,
        IUnknown* effect
    ) noexcept -> HRESULT override;
    auto DrawStrikethrough(
        void* context,
        FLOAT origin_x,
        FLOAT origin_y,
        const DWRITE_STRIKETHROUGH* strikethrough,
        IUnknown* effect
    ) noexcept -> HRESULT override;
    auto DrawInlineObject(
        void* context,
        FLOAT origin_x,
        FLOAT origin_y,
        IDWriteInlineObject* inline_object,
        BOOL is_sideways,
        BOOL is_right_to_left,
        IUnknown* effect
    ) noexcept -> HRESULT override;

private:
    std::vector<collected_run> m_runs;
    // Runs drawn meanwhile belong to the inline object (the trimming sign), which stands for no
    // text of the layout's.
    bool m_is_in_inline_object = false;
};

}
