#pragma once

#include <optional>
#include <vector>

namespace lucent::kit {

// A key or mouse button, by its Windows virtual-key code (VK_LBUTTON, VK_XBUTTON1, 'A', VK_F1),
// which the glue reads from the game window's messages. Public Win32 values, never game facts.
enum class input_key : u8 {};

// VK_ESCAPE: what cancels setting a bind, so it is never one.
inline constexpr input_key escape_key{0x1b};

// How a bind makes its feature active while the feature is on.
enum class bind_mode : u8 {
    always,
    // While its key is held.
    hold,
    // From one press of its key to the next.
    toggle,
};

// The bind a feature's switch carries. It decides the feature's activity, never its lifecycle: a
// bind makes an on feature active, and never turns a feature on or off.
struct bind_slot {
    bind_mode mode = bind_mode::always;
    // Absent: a hold or toggle that stays inactive until a key is set; always ignores it.
    std::optional<input_key> key;

    auto operator==(const bind_slot&) const -> bool = default;
};

// A key going down or up. A down while it is already down (the keyboard's repeat) is no press.
struct key_change {
    input_key key{};
    bool is_down = false;

    auto operator==(const key_change&) const -> bool = default;
};

// The keys between one tick and the next, in the order they changed: what the glue feeds binds
// from, so kit never sees the overlay's input types.
struct key_input {
    std::vector<key_change> changes;

    auto operator==(const key_input&) const -> bool = default;
};

}
