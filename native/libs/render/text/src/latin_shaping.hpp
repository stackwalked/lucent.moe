#pragma once

#include <optional>
#include <span>
#include <string_view>

#include <dwrite_3.h>

namespace lucent::text {

// The script analysis DirectWrite itemizes Latin text with, found by analyzing one Latin letter.
// Script ids are DirectWrite's own numbering, which no header names.
auto latin_script(IDWriteTextAnalyzer1& analyzer) -> result<DWRITE_SCRIPT_ANALYSIS>;

// Whether a default Latin substitution whose context can reach past a pair covers the glyph: a
// string holding it may come out as other glyphs.
auto is_substitutable(
    IDWriteTextAnalyzer2& analyzer, IDWriteFontFace& face, DWRITE_SCRIPT_ANALYSIS script, u16 glyph
) -> result<bool>;

// One or two Latin characters, their cmap glyphs, and those glyphs' design advances.
struct unshaped_text {
    std::wstring_view text;
    std::span<const u16> glyphs;
    std::span<const i32> advances;
};

// What shaping the text adds to its first glyph's advance, in design units: the pair's kerning
// (zero for one character). Absent when shaping does more than that (substitutes, joins, moves a
// glyph off its pen, or changes the last advance), which the fast path can't reproduce.
auto pair_kerning(
    IDWriteTextAnalyzer1& analyzer,
    IDWriteFontFace& face,
    DWRITE_SCRIPT_ANALYSIS script,
    const unshaped_text& unshaped
) -> result<std::optional<i32>>;

}
