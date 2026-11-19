#pragma once

#include <optional>

#include <lucent/core/flags.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

// What an element responds to.
enum class sense : u8 {
    // A left press on it and a release over it.
    click = 1U << 0U,
    // A left press on it holds it until the release, wherever the cursor goes.
    drag = 1U << 1U,
    // Takes focus when pressed and from Tab; Enter or Space activates it.
    focus = 1U << 2U,
};

// An element's response to this frame's input, judged against its rect from the previous frame.
struct interaction {
    element_id id{};
    bool is_hovered = false;
    // Held by a left press that began on it.
    bool is_pressed = false;
    // The press began this frame.
    bool is_just_pressed = false;
    // Released over it, or Enter or Space while it has focus.
    bool is_activated = false;
    bool is_focused = false;
    // Its rect last frame; absent on the frame it first appears.
    std::optional<draw::rect> rect;
    std::optional<draw::vec2> cursor;
};

}
