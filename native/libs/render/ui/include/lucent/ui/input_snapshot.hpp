#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include <lucent/core/flags.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::ui {

// One mouse button over a frame.
struct button_input {
    bool is_down = false;
    // Zero when it wasn't pressed this frame; otherwise the press's click count (two for the second
    // press of a double click), as the window procedure counted it.
    i32 click_count = 0;
    bool is_released = false;
};

enum class key_code : u8 {
    tab,
    enter,
    space,
    escape,
    backspace,
    left,
    right,
    up,
    down,
    home,
    end,
    page_up,
    page_down,
};

enum class key_action : u8 {
    pressed,
    released,
    // Held long enough for the keyboard to repeat it.
    repeated,
};

struct key_event {
    key_code code = key_code::tab;
    key_action action = key_action::pressed;

    auto operator==(const key_event&) const -> bool = default;
};

enum class modifier : u8 {
    shift = 1U << 0U,
    control = 1U << 1U,
    alt = 1U << 2U,
};

inline constexpr flags<modifier> no_modifiers{};

// Everything the UI reads from the outside world in one frame. The glue builds one per frame; given
// the same snapshots, the UI does the same thing.
struct input_snapshot {
    // The injected clock's time this frame was built at.
    std::chrono::steady_clock::time_point time;
    // In units, from the viewport's top left; absent while the cursor is outside it.
    std::optional<draw::vec2> cursor;
    button_input left;
    button_input right;
    button_input middle;
    // Wheel notches this frame; y is positive away from the user, x to the right.
    draw::vec2 wheel;
    // In the order they happened.
    std::vector<key_event> keys;
    // UTF-8 typed this frame.
    std::string text;
    flags<modifier> modifiers = no_modifiers;
};

auto has_key(const input_snapshot& input, key_event event) -> bool;
// Pressed, or repeated while held: what moves a selection.
auto has_press(const input_snapshot& input, key_code code) -> bool;

}
