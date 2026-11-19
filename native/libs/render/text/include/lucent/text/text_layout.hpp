#pragma once

#include <optional>
#include <string_view>
#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::text {

// A face the text system knows: one of ours, registered from bytes, or a system face fallback
// found. Ids come from one text system and mean nothing to another.
enum class face_id : u16 {};

struct text_style {
    face_id face{};
    // The em size, in units.
    f32 size = 16.0F;
};

enum class text_wrap : u8 {
    // One line per hard line break, however wide.
    none,
    // Lines break between words at max_width; a word wider than a line breaks inside itself.
    words,
};

enum class text_overflow : u8 {
    visible,
    // Text past max_width (or past the last line max_lines allows) is cut at a character and an
    // ellipsis takes its place.
    ellipsis,
};

// Text to lay out, borrowed for the call.
struct layout_request {
    std::string_view utf8;
    text_style style;
    // In units; ignored when nothing wraps or cuts.
    f32 max_width = 0.0F;
    text_wrap wrap = text_wrap::none;
    text_overflow overflow = text_overflow::visible;
    std::optional<isize> max_lines;
    // The draw list's pixels_per_unit: glyphs are shaped and rasterized at size times this, and
    // the layout draws only on a list of the same scale.
    f32 pixels_per_unit = 1.0F;
};

// One glyph where it lands. pen is in pixels from the layout's top left: x on the glyph's origin
// (fractional: the draw picks the subpixel phase), y on its line's baseline (whole).
struct placed_glyph {
    face_id face{};
    u16 index = 0;
    // The em size in pixels the glyph is rasterized at.
    f32 em_size = 0.0F;
    draw::vec2 pen;
    // In pixels, along the line.
    f32 advance = 0.0F;
    // The byte in the UTF-8 where its cluster starts; an ellipsis takes the end of what it cut.
    isize text_offset = 0;
    // A COLR layer's colour; absent draws in the text's own colour.
    std::optional<draw::color> layer_color;
};

// Glyphs [first_glyph, first_glyph + glyph_count) of the layout, in visual order for a line that
// is all left to right and in run order otherwise. text_begin and text_end are bytes of the UTF-8.
struct text_line {
    isize first_glyph = 0;
    isize glyph_count = 0;
    isize text_begin = 0;
    isize text_end = 0;
    // In units, trailing whitespace left out.
    f32 width = 0.0F;
};

// Laid-out text, whichever path made it: its lines, the glyphs to draw, and its measure.
struct text_layout {
    std::vector<placed_glyph> glyphs;
    std::vector<text_line> lines;
    // In units: the widest line's width, and line_height for every line.
    draw::vec2 size;
    // Every line is this tall, set by the style's own face, so a line keeps its height when a
    // fallback face with taller metrics appears on it. In units.
    f32 line_height = 0.0F;
    // The first line's baseline from the top, in units.
    f32 baseline = 0.0F;
    f32 pixels_per_unit = 1.0F;
    bool is_truncated = false;
};

}
