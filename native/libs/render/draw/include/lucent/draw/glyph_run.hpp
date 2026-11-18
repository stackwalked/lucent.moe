#pragma once

#include <span>

#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>

namespace lucent::draw {

// A slice of the atlas texture array: glyph and icon pages alike, so text and icons spanning pages
// never split a batch.
enum class atlas_page : u16 {};

// The atlas texture array: fixed A8 pages (the text system evicts a page rather than growing it).
inline constexpr i32 atlas_page_size = 1024;
inline constexpr isize atlas_page_count = 16;

// One coverage quad from the atlas, tinted. bounds are in pixels from the run's origin: the text
// system rasterized them on the pixel grid (and chose the horizontal subpixel phase), so the list
// places them without scaling. A COLR emoji is several quads with their own tints.
struct glyph_quad {
    atlas_page page{};
    rect bounds;
    rect uv;
    color tint = white;
};

// The origin, in units, lands on a whole pixel.
struct glyph_run {
    vec2 origin;
    std::span<const glyph_quad> glyphs;
};

}
