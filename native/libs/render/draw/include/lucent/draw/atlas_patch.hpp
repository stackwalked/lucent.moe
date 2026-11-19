#pragma once

#include <cstddef>
#include <span>

#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>

namespace lucent::draw {

// Coverage changed in part of an atlas page: one byte a texel, rows row_pitch bytes apart,
// starting at the area's first texel. The text system makes them and a backend uploads them; the
// bytes are borrowed from whoever made the patch.
struct atlas_patch {
    atlas_page page{};
    pixel_rect area;
    std::span<const std::byte> coverage;
    isize row_pitch = 0;
};

}
