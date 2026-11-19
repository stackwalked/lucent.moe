#pragma once

#include <expected>
#include <optional>
#include <span>
#include <variant>
#include <vector>

namespace lucent::cs2 {

// The buttons a command carries, at the game's bits.
// build: cs2 1.41.9.9
// found: Source's IN_* bits (in_buttons.h), unchanged in cs2; old lucent's in_button pressed and
// read each of them through the same words, and its fire and movement stages were measured with
// attack, jump, duck and the move keys
// breaks: a request presses another button than it names
enum class button : u32 {
    attack = 1U << 0U,
    jump = 1U << 1U,
    duck = 1U << 2U,
    forward = 1U << 3U,
    back = 1U << 4U,
    use = 1U << 5U,
    move_left = 1U << 9U,
    move_right = 1U << 10U,
    attack2 = 1U << 11U,
    reload = 1U << 13U,
    walk = 1U << 16U,
};

// createmove's stages, in precedence order: an earlier stage wins a button a later one also asks
// for. Scripts come last, below every built-in feature.
enum class stage : u8 { movement, aim_view, aim_shot, trigger, scripts };

// One subtick step as the command carries it. A field the game didn't set is absent, and stays
// absent when the step is written back.
struct subtick_step {
    // Where in the tick it happens, 0 up to 1.
    f32 when = 0.0F;
    std::optional<u64> buttons;
    std::optional<bool> is_pressed;
    // The analog move axes' change.
    std::optional<f32> forward;
    std::optional<f32> left;
    // The view's change.
    std::optional<f32> pitch;
    std::optional<f32> yaw;
};

enum class edge : u8 { press, release };

// A button pressed or released at a moment of the tick.
struct button_step {
    button which = button::attack;
    edge change = edge::press;
    f32 when = 0.0F;
};

// The analog move axes changed at a moment of the tick: what only the movement stage writes.
struct analog_step {
    f32 when = 0.0F;
    f32 forward = 0.0F;
    f32 left = 0.0F;
};

using step_request = std::variant<button_step, analog_step>;

struct stage_request {
    stage from = stage::movement;
    step_request step;
};

enum class refusal_reason : u8 {
    // Its moment isn't inside the tick.
    outside_tick,
    // A step carries one button, never none or several.
    not_one_button,
    // A press and a release would land at the same moment.
    press_meets_release,
    // The command would carry more steps than the game takes.
    too_many_steps,
    // An analog change past a whole key's swing, or not a number.
    over_analog_cap,
    // An earlier stage asked for the same button this tick.
    taken_by_earlier_stage,
};

// A request that didn't go into the command, and why.
struct step_refusal {
    refusal_reason reason = refusal_reason::outside_tick;
    stage_request refused;
};

// The most steps one command carries: what the game's own check allows, less the room the engine
// keeps for steps it packs itself.
// build: cs2 1.41.9.9
// found: old lucent's subtick::step_limit, after the client's check refusing a list of more than
// 32 (old lucent docs/re/movement-sim.md 8.10)
// breaks: a command the client trims or refuses
inline constexpr isize max_steps = 30;

// The grain a requested step's moment is rounded to, and the most one analog change may move an
// axis (a whole key's swing).
inline constexpr f32 when_grain = 1.0F / 64.0F;
inline constexpr f32 analog_cap = 1.0F;

// The command's steps once the requested ones are in: every requested step's moment rounded to
// when_grain, the whole list ordered by moment (kept steps first among equals, requests in their
// order). Refuses the whole list, naming the first request at fault, rather than leaving one out.
// The kept steps are the game's and pass as they are.
auto emit(std::span<const subtick_step> kept, std::span<const stage_request> requests)
    -> std::expected<std::vector<subtick_step>, step_refusal>;

// A command's button state: down now, changed this tick, and the edges the game has consumed.
struct button_state {
    u64 held = 0;
    u64 changed = 0;
    u64 scroll = 0;

    auto operator==(const button_state&) const -> bool = default;
};

// What the game built for this tick, before any stage wrote to it.
struct game_command {
    button_state buttons;
    std::vector<subtick_step> steps;
};

// What the command should carry once every stage's requests are in.
struct command_plan {
    button_state buttons;
    std::vector<subtick_step> steps;
};

struct planned {
    // Empty when emit refused: the command stays as the game built it.
    std::optional<command_plan> plan;
    std::vector<step_refusal> refusals;
};

// The command domain's one conflict rule, applied once a tick. Each button belongs, this tick, to
// the earliest stage that asks for it: the later stages' requests for it are refused, and the
// game's own steps for it are dropped (the player's input gives way to a stage that took the
// button). A button's words follow its owner's steps: down if its last step pressed it, changed
// if any step moved it off its state at the start of the tick. An analog request drops the
// game's analog-only steps the same way. Everything else of the game's stays.
auto plan_command(const game_command& game, std::span<const stage_request> requests) -> planned;

}
