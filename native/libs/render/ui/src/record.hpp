#pragma once

#include <vector>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/context.hpp>

#include "element.hpp"

namespace lucent::ui::detail {

// The frame's, borrowed for the call; none null.
struct record_input {
    const std::vector<element>* elements = nullptr;
    // Root elements, bottom to top.
    const std::vector<isize>* order = nullptr;
    std::vector<custom_draw>* drawers = nullptr;
    draw::color rail;
    // The rail's colour while held.
    draw::color held_rail;
    f32 rail_width = 0.0F;
};

auto record_roots(draw::draw_list& list, text::text_system& text, const record_input& input)
    -> result<void>;

}
