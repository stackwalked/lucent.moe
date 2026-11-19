#pragma once

#include <string_view>
#include <vector>

#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_system.hpp>

#include "element.hpp"

namespace lucent::ui::detail {

struct layout_frame {
    draw::vec2 viewport;
    f32 pixels_per_unit = 1.0F;
    f32 popup_gap = 0.0F;
    // What text leaves' offsets index.
    std::string_view strings;
    // Borrowed for the call; never null.
    const std::vector<root_entry>* roots = nullptr;
};

// Widths bottom-up then top-down, text wrapped at its final width, heights the same way, then
// positions and clips. The text leaves keep layouts borrowed from text until its next frame.
auto lay_out(std::vector<element>& elements, text::text_system& text, const layout_frame& frame)
    -> result<void>;

}
