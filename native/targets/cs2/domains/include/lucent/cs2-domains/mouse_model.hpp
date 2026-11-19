#pragma once

#include <optional>

namespace lucent::cs2 {

// Where the view looks, in degrees: pitch down positive, yaw counterclockwise positive, as the
// game holds them.
struct heading {
    f32 pitch = 0.0F;
    f32 yaw = 0.0F;
};

// A change of heading a feature asks for, in degrees.
struct view_turn {
    f32 pitch = 0.0F;
    f32 yaw = 0.0F;
};

// What one mouse count turns the view by on each axis, signed as the game's own conversion turns
// it: a count right turns yaw by `yaw`, a count down turns pitch by `pitch`.
struct count_size {
    f32 pitch = 0.0F;
    f32 yaw = 0.0F;
};

struct mouse_counts {
    i32 dx = 0;
    i32 dy = 0;

    auto operator==(const mouse_counts&) const -> bool = default;
};

// The most counts one command carries on an axis: a real mouse's 8 kHz report rate over a 64 Hz
// tick, one count a report, less one.
// build: cs2 1.41.9.9
// found: cs2's fixed 64-tick interval (old lucent read it from the globals and capped the same,
// counts_per_command()); the rate is the product rule (wishlist, cs2 features)
// breaks: a command carrying more counts than any mouse sends
inline constexpr i32 counts_per_command = 124;

// The game clamps pitch to this either way.
// build: cs2 1.41.9.9
// found: old lucent's aim clamped to it after every turn, and the game's own clamp reads it
// (cl_pitchdown / cl_pitchup default 89)
// breaks: a turn the game clamps after it, leaving counts the view didn't turn by
inline constexpr f32 pitch_limit = 89.0F;

// The view as a mouse moves it. Requests add up, from any feature; the view turns only by whole
// counts, no more in total than one command carries until a command takes them, and the counts it
// turned by are owed to the next command. Whatever didn't fit stays asked for.
//
// Pure: the view domain reads the heading and count size, sets what turn() answers, and settles
// what it owes into the command.
class mouse_model final {
public:
    auto request(view_turn wanted) -> void;

    // The heading the view moves to now, or none when no whole count of what was asked for fits.
    auto turn(heading now, count_size size) -> std::optional<heading>;

    // The counts the view turned by since the last command took them; owed nothing after.
    auto settle() -> mouse_counts;

    // Drops what was asked for and what is owed: there is no view or command to carry them.
    auto forget() -> void;

    auto pending() const -> view_turn;
    auto owed() const -> mouse_counts;

private:
    view_turn m_pending;
    mouse_counts m_owed;
};

}
