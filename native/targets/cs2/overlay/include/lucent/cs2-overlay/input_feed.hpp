#pragma once

#include <array>
#include <chrono>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <lucent/core/flags.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/input_snapshot.hpp>

namespace lucent::cs2::overlay {

enum class mouse_button : u8 { left, right, middle };

inline constexpr isize mouse_button_count = 3;

struct button_press {
    mouse_button button = mouse_button::left;
    // Two for the second press of a double click.
    i32 click_count = 1;
};

struct button_release {
    mouse_button button = mouse_button::left;
};

// Wheel notches: y positive away from the user, x to the right.
struct wheel_turn {
    draw::vec2 notches;
};

struct typed_text {
    std::string utf8;
};

using input_event =
    std::variant<button_press, button_release, wheel_turn, ui::key_event, typed_text>;

struct sequenced_event {
    // The feed's serial when it was recorded.
    u64 serial = 0;
    input_event event;
};

// The game window's input as its window procedure last left it: what that thread publishes for the
// presenting thread, which turns it into one ui snapshot a frame.
struct input_feed {
    bool is_menu_open = false;
    // Counts events and openings of the menu since the window was subclassed; never goes back.
    u64 serial = 0;
    // In the window's client pixels; absent before the first mouse message and after focus loss.
    std::optional<draw::vec2> cursor;
    // Held now, by mouse_button.
    std::array<bool, mouse_button_count> buttons{};
    flags<ui::modifier> modifiers = ui::no_modifiers;
    // Only while the menu is open, oldest first; those the presenting thread has reported consumed
    // are dropped.
    std::vector<sequenced_event> events;
};

// What one frame's snapshot is placed by.
struct frame_place {
    // The injected clock's.
    std::chrono::steady_clock::time_point time;
    // The window's client area in pixels, and the viewport the UI lays out in, in units.
    draw::vec2 client_size;
    draw::vec2 viewport;
};

struct frame_snapshot {
    ui::input_snapshot input;
    // The feed's serial this snapshot took everything up to: the next frame starts after it.
    u64 consumed = 0;
};

// One frame's snapshot from the events after `consumed` (those it already took) and the state the
// feed holds now. The cursor is scaled from client pixels to the viewport's units.
auto snapshot_of(const input_feed& feed, u64 consumed, const frame_place& place) -> frame_snapshot;

}
