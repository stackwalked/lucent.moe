#include "latin_shaping.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <expected>
#include <optional>
#include <span>
#include <string_view>

#include <dwrite_3.h>

#include <lucent/core/narrow.hpp>

#include "direct_write.hpp"

namespace lucent::text {
namespace {

constexpr const wchar_t* english = L"en-us";

constexpr auto opentype_tag(std::string_view name) -> DWRITE_FONT_FEATURE_TAG {
    return static_cast<DWRITE_FONT_FEATURE_TAG>(
        u32{static_cast<u8>(name.at(0))}
        | (u32{static_cast<u8>(name.at(1))} << 8U)
        | (u32{static_cast<u8>(name.at(2))} << 16U)
        | (u32{static_cast<u8>(name.at(3))} << 24U)
    );
}

// The default Latin substitutions whose context can reach past a pair of glyphs. The rest (ccmp,
// locl, liga) are caught by shaping each pair: without combining marks, which the fast path
// refuses, they replace one glyph or join two.
// found: the OpenType Latin shaping specification's default feature list; ccmp and liga left
// here refused nearly every string of the fixture font (their coverage holds base letters).
// breaks: a contextual substitution left off lets the fast path draw glyphs IDWriteTextLayout
// would have replaced; the agreement tests catch it for the fixture font only.
constexpr std::array contextual_substitutions{
    opentype_tag("rlig"),
    opentype_tag("clig"),
    opentype_tag("calt"),
    opentype_tag("rclt"),
};

// The text source and result sink DirectWrite's script analysis asks for, over one string.
// Lives on the stack for one AnalyzeScript call, so its reference count owns nothing.
class script_probe final : public IDWriteTextAnalysisSource, public IDWriteTextAnalysisSink {
public:
    explicit script_probe(std::wstring_view text)
        : m_text{text} {}

    auto found() const -> std::optional<DWRITE_SCRIPT_ANALYSIS> {
        return m_found;
    }

    auto QueryInterface(const IID& interface_id, void** object) noexcept -> HRESULT override {
        if (object == nullptr) {
            return E_POINTER;
        }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // COM names interfaces by __uuidof
        const bool is_source = interface_id == __uuidof(IUnknown)
                               || interface_id == __uuidof(IDWriteTextAnalysisSource);
        const bool is_sink = interface_id == __uuidof(IDWriteTextAnalysisSink);
#pragma clang diagnostic pop
        if (is_source) {
            *object = static_cast<IDWriteTextAnalysisSource*>(this);
            return S_OK;
        }
        if (is_sink) {
            *object = static_cast<IDWriteTextAnalysisSink*>(this);
            return S_OK;
        }
        *object = nullptr;
        return E_NOINTERFACE;
    }

    auto AddRef() noexcept -> ULONG override {
        return 1;
    }

    auto Release() noexcept -> ULONG override {
        return 1;
    }

    auto GetTextAtPosition(UINT32 position, const WCHAR** text, UINT32* length) noexcept
        -> HRESULT override {
        if (position >= m_text.size()) {
            *text = nullptr;
            *length = 0;
            return S_OK;
        }
        const std::wstring_view rest = m_text.substr(position);
        *text = rest.data();
        *length = narrow<UINT32>(std::ssize(rest));
        return S_OK;
    }

    auto GetTextBeforePosition(UINT32 position, const WCHAR** text, UINT32* length) noexcept
        -> HRESULT override {
        if (position == 0 || position > m_text.size()) {
            *text = nullptr;
            *length = 0;
            return S_OK;
        }
        *text = m_text.data();
        *length = position;
        return S_OK;
    }

    auto GetParagraphReadingDirection() noexcept -> DWRITE_READING_DIRECTION override {
        return DWRITE_READING_DIRECTION_LEFT_TO_RIGHT;
    }

    auto GetLocaleName(UINT32 position, UINT32* length, const WCHAR** locale) noexcept
        -> HRESULT override {
        *length = narrow<UINT32>(std::ssize(m_text))
                  - std::min(position, narrow<UINT32>(std::ssize(m_text)));
        *locale = english;
        return S_OK;
    }

    auto GetNumberSubstitution(
        UINT32 position, UINT32* length, IDWriteNumberSubstitution** substitution
    ) noexcept -> HRESULT override {
        *length = narrow<UINT32>(std::ssize(m_text))
                  - std::min(position, narrow<UINT32>(std::ssize(m_text)));
        *substitution = nullptr;
        return S_OK;
    }

    auto SetScriptAnalysis(
        UINT32 /*position*/, UINT32 /*length*/, const DWRITE_SCRIPT_ANALYSIS* analysis
    ) noexcept -> HRESULT override {
        m_found = *analysis;
        return S_OK;
    }

    auto SetLineBreakpoints(
        UINT32 /*position*/, UINT32 /*length*/, const DWRITE_LINE_BREAKPOINT* /*breakpoints*/
    ) noexcept -> HRESULT override {
        return S_OK;
    }

    auto SetBidiLevel(
        UINT32 /*position*/, UINT32 /*length*/, UINT8 /*explicit_level*/, UINT8 /*resolved_level*/
    ) noexcept -> HRESULT override {
        return S_OK;
    }

    auto SetNumberSubstitution(
        UINT32 /*position*/, UINT32 /*length*/, IDWriteNumberSubstitution* /*substitution*/
    ) noexcept -> HRESULT override {
        return S_OK;
    }

private:
    std::wstring_view m_text;
    std::optional<DWRITE_SCRIPT_ANALYSIS> m_found;
};

}

auto latin_script(IDWriteTextAnalyzer1& analyzer) -> result<DWRITE_SCRIPT_ANALYSIS> {
    script_probe probe{L"a"};
    LUCENT_TRY(checked(analyzer.AnalyzeScript(&probe, 0, 1, &probe)));
    const std::optional<DWRITE_SCRIPT_ANALYSIS> found = probe.found();
    if (!found) {
        return std::unexpected(error{.code = error_code::unsupported, .system_code = 0});
    }
    return *found;
}

auto is_substitutable(
    IDWriteTextAnalyzer2& analyzer, IDWriteFontFace& face, DWRITE_SCRIPT_ANALYSIS script, u16 glyph
) -> result<bool> {
    for (const DWRITE_FONT_FEATURE_TAG feature : contextual_substitutions) {
        UINT8 applies = 0;
        LUCENT_TRY(checked(
            analyzer.CheckTypographicFeature(&face, script, english, feature, 1, &glyph, &applies)
        ));
        if (applies != 0) {
            return true;
        }
    }
    return false;
}

auto pair_kerning(
    IDWriteTextAnalyzer1& analyzer,
    IDWriteFontFace& face,
    DWRITE_SCRIPT_ANALYSIS script,
    const unshaped_text& unshaped
) -> result<std::optional<i32>> {
    const isize length = std::ssize(unshaped.text);
    LUCENT_INVARIANT(
        (length == 1 || length == 2)
        && std::ssize(unshaped.glyphs) == length
        && std::ssize(unshaped.advances) == length
    );
    const auto count = narrow<UINT32>(length);
    // A copy, so DirectWrite reads an array we own rather than a view into the caller's text.
    std::array<WCHAR, 2> text{};
    std::ranges::copy(unshaped.text, text.begin());
    constexpr usize most_glyphs = 8;
    std::array<UINT16, 2> clusters{};
    std::array<DWRITE_SHAPING_TEXT_PROPERTIES, 2> text_properties{};
    std::array<UINT16, most_glyphs> glyphs{};
    std::array<DWRITE_SHAPING_GLYPH_PROPERTIES, most_glyphs> glyph_properties{};
    UINT32 glyph_count = 0;
    LUCENT_TRY(checked(analyzer.GetGlyphs(
        text.data(),
        count,
        &face,
        FALSE,
        FALSE,
        &script,
        english,
        nullptr,
        nullptr,
        nullptr,
        0,
        narrow<UINT32>(most_glyphs),
        clusters.data(),
        text_properties.data(),
        glyphs.data(),
        glyph_properties.data(),
        &glyph_count
    )));
    const bool is_substituted =
        glyph_count != count
        || !std::ranges::equal(std::span{glyphs}.first(narrow<usize>(length)), unshaped.glyphs);
    if (is_substituted) {
        return std::nullopt;
    }
    DWRITE_FONT_METRICS metrics{};
    face.GetMetrics(&metrics);
    std::array<FLOAT, 2> advances{};
    std::array<DWRITE_GLYPH_OFFSET, 2> offsets{};
    // At an em of the design units, advances come back in design units.
    LUCENT_TRY(checked(analyzer.GetGlyphPlacements(
        text.data(),
        clusters.data(),
        text_properties.data(),
        count,
        glyphs.data(),
        glyph_properties.data(),
        count,
        &face,
        static_cast<f32>(metrics.designUnitsPerEm),
        FALSE,
        FALSE,
        &script,
        english,
        nullptr,
        nullptr,
        0,
        advances.data(),
        offsets.data()
    )));
    const bool is_offset = std::ranges::any_of(offsets, [](const DWRITE_GLYPH_OFFSET& offset) {
        return offset.advanceOffset != 0.0F || offset.ascenderOffset != 0.0F;
    });
    const auto last = narrow<usize>(length - 1);
    const bool is_last_moved =
        static_cast<i32>(std::round(advances.at(last))) != unshaped.advances.back();
    if (is_offset || is_last_moved) {
        return std::nullopt;
    }
    return static_cast<i32>(std::round(advances[0])) - unshaped.advances.front();
}

}
