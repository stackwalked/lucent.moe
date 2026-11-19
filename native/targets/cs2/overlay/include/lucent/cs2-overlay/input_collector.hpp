#pragma once

#include <array>
#include <chrono>
#include <optional>

#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::cs2::overlay {

// One message the game window's procedure received, as plain values.
struct window_message {
    u32 id = 0;
    u64 wparam = 0;
    i64 lparam = 0;
    // GetMessageTime(): milliseconds, wrapping around.
    u32 time = 0;
};

// The system's double-click rules: GetDoubleClickTime(), and SM_CXDOUBLECLK by SM_CYDOUBLECLK, the
// area a second press must land in around the first.
struct click_rules {
    std::chrono::milliseconds interval{500};
    draw::vec2 area{.x = 4.0F, .y = 4.0F};
};

// Shift, control and alt: ui::modifier's values.
inline constexpr usize modifier_count = 3;

enum class message_kind : u8 {
    // Not input, or input the game always gets: releases (so nothing stays held in the game),
    // focus changes, and system keys (Alt+F4 and Alt+Enter stay the system's).
    other,
    mouse,
    keyboard,
    // The key that opens and closes the menu: never the game's.
    menu_key,
};

// What kind of input a window message is, which decides whether the game may be kept from it.
// WM_INPUT is other here: its device is in the data the handle names, which the glue reads.
auto kind_of(const window_message& message) -> message_kind;

// What the presenting thread reports after a frame of the open menu.
struct menu_report {
    // The feed's serial the frame's snapshot took everything up to.
    u64 consumed = 0;
    bool wants_mouse = false;
    bool wants_keyboard = false;
};

// The window procedure's side of the menu's input: it turns the game window's messages into the
// feed the presenting thread snapshots, opens and closes the menu, and decides which messages the
// game doesn't see. Lives on the window's thread; the presenting thread reaches it only through
// what is published from it and to it.
class input_collector final {
public:
    explicit input_collector(click_rules rules);

    auto record(const window_message& message) -> void;
    // Drops the events the presenting thread consumed. What the UI wants is taken only from a
    // report on a frame of this opening of the menu.
    auto acknowledge(const menu_report& report) -> void;

    // While the menu is open and the UI wants that device, or for the menu's key.
    auto should_keep_from_game(message_kind kind) const -> bool;
    auto feed() const -> const input_feed&;

private:
    struct last_press {
        mouse_button button = mouse_button::left;
        u32 time = 0;
        draw::vec2 position;
        i32 click_count = 0;
    };

    auto add_event(input_event event) -> void;
    // Every key and button into the feed's tally, whatever the menu does.
    auto tally(const window_message& message) -> void;
    auto press_key(u64 virtual_key) -> void;
    auto release_key(u64 virtual_key) -> void;
    auto press(mouse_button button, const window_message& message) -> void;
    auto release(mouse_button button) -> void;
    auto key_down(const window_message& message) -> void;
    auto key_up(const window_message& message) -> void;
    auto type(u16 unit) -> void;
    auto lose_focus() -> void;
    auto toggle_menu() -> void;
    auto hold_modifier(u64 virtual_key) -> void;
    auto drop_modifier(u64 virtual_key) -> void;

    click_rules m_rules;
    input_feed m_feed;
    std::optional<last_press> m_last_press;
    // Shift, control and alt.
    std::array<bool, modifier_count> m_held_modifiers{};
    // The first half of a UTF-16 surrogate pair, until its second arrives.
    std::optional<u16> m_high_surrogate;
    // The serial this opening of the menu began at.
    u64 m_opened_at = 0;
    menu_report m_wanted;
};

}
