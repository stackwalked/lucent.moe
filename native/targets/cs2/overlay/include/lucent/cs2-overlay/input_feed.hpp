#pragma once

#include <array>
#include <chrono>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include <lucent/core/flags.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/bind.hpp>
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

// Every key and mouse button, by its virtual-key code (kit::input_key): whether it is down now, and
// its presses counted since the window was subclassed (wrapping), so a reader that looks once a
// frame misses no press however short. Kept whether the menu is open or not: binds read it.
struct key_tally {
    std::array<bool, 256> is_down{};
    std::array<u32, 256> presses{};

    auto operator==(const key_tally&) const -> bool = default;
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
    key_tally keys;
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

// The key changes from the tally a reader took last to the one now, as binds read them, key by
// key in code order. Presses past two between looks collapse to one or two, which keeps a toggle's
// parity.
auto key_input_of(const key_tally& now, const key_tally& taken) -> kit::key_input;

// Only the releases: what binds get while the open menu has the keys, so typing in it toggles
// nothing, and a key let go meanwhile still lets go of its hold.
auto releases_of(const kit::key_input& keys) -> kit::key_input;

}
