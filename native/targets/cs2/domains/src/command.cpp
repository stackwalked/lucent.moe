#include <lucent/cs2-domains/command.hpp>

#include <algorithm>
#include <bit>
#include <cmath>
#include <expected>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>

namespace lucent::cs2 {
namespace {

constexpr f32 grains = 64.0F;

auto bits_of(button which) -> u64 {
    return u64{std::to_underlying(which)};
}

auto is_pressing(edge change) -> bool {
    return change == edge::press;
}

auto refusal(refusal_reason reason, const stage_request& refused) -> step_refusal {
    return step_refusal{.reason = reason, .refused = refused};
}

// The moment rounded to the grain; empty outside the tick.
auto rounded(f32 when) -> std::optional<f32> {
    if (!std::isfinite(when) || when < 0.0F) {
        return std::nullopt;
    }
    const f32 grain = std::round(when * grains);
    if (grain >= grains) {
        return std::nullopt;
    }
    return grain / grains;
}

auto is_within_cap(f32 change) -> bool {
    return std::isfinite(change) && std::abs(change) <= analog_cap;
}

auto step_of(const button_step& requested, f32 when) -> subtick_step {
    return subtick_step{
        .when = when,
        .buttons = bits_of(requested.which),
        .is_pressed = is_pressing(requested.change),
        .forward = std::nullopt,
        .left = std::nullopt,
        .pitch = std::nullopt,
        .yaw = std::nullopt,
    };
}

auto step_of(const analog_step& requested, f32 when) -> subtick_step {
    return subtick_step{
        .when = when,
        .buttons = std::nullopt,
        .is_pressed = std::nullopt,
        .forward = requested.forward,
        .left = requested.left,
        .pitch = std::nullopt,
        .yaw = std::nullopt,
    };
}

auto moment_of(const step_request& requested) -> f32 {
    return match(requested, [](const auto& step) { return step.when; });
}

// The requested step as it goes into the command, or why it can't.
auto checked(const stage_request& requested) -> std::expected<subtick_step, step_refusal> {
    const std::optional<f32> when = rounded(moment_of(requested.step));
    if (!when) {
        return std::unexpected(refusal(refusal_reason::outside_tick, requested));
    }
    return match(
        requested.step,
        [&](const button_step& pressed) -> std::expected<subtick_step, step_refusal> {
            if (std::popcount(bits_of(pressed.which)) != 1) {
                return std::unexpected(refusal(refusal_reason::not_one_button, requested));
            }
            return step_of(pressed, *when);
        },
        [&](const analog_step& moved) -> std::expected<subtick_step, step_refusal> {
            if (!is_within_cap(moved.forward) || !is_within_cap(moved.left)) {
                return std::unexpected(refusal(refusal_reason::over_analog_cap, requested));
            }
            return step_of(moved, *when);
        }
    );
}

// Moments closer than this are one: the game's own steps aren't on the 64th grid.
constexpr f32 same_moment = 1.0e-5F;

auto is_same_moment(f32 first, f32 second) -> bool {
    return std::abs(first - second) < same_moment;
}

// The button a request presses or releases; none for an analog change.
auto button_of(const step_request& requested) -> std::optional<u64> {
    return match(
        requested,
        [](const button_step& pressed) { return std::optional{bits_of(pressed.which)}; },
        [](const analog_step& /*moved*/) { return std::optional<u64>{}; }
    );
}

auto is_button_change(const subtick_step& step) -> bool {
    return step.buttons.has_value() && *step.buttons != 0;
}

// Whether the step presses or releases any of the bits.
auto touches(const subtick_step& step, u64 bits) -> bool {
    return (step.buttons.value_or(0) & bits) != 0;
}

auto is_pressed(const subtick_step& step) -> bool {
    return step.is_pressed.value_or(false);
}

// Whether a step of the list changes a button the other way at the same moment.
auto meets_opposite(std::span<const subtick_step> steps, const subtick_step& made) -> bool {
    return std::ranges::any_of(steps, [&made](const subtick_step& other) {
        return is_button_change(other)
               && is_same_moment(other.when, made.when)
               && is_pressed(other) != is_pressed(made);
    });
}

auto is_analog_only(const subtick_step& step) -> bool {
    return !is_button_change(step) && (step.forward.has_value() || step.left.has_value());
}

// The earliest stage asking for each button bit this tick, as a mask per stage.
auto owned_bits(std::span<const stage_request> requests) -> std::vector<u64> {
    std::vector<u64> owned(std::to_underlying(stage::scripts) + 1U, 0);
    u64 taken = 0;
    std::vector<stage_request> ordered{requests.begin(), requests.end()};
    std::ranges::stable_sort(ordered, {}, &stage_request::from);
    for (const stage_request& requested : ordered) {
        const std::optional<u64> pressed = button_of(requested.step);
        if (!pressed) {
            continue;
        }
        const u64 bits = *pressed;
        if ((taken & bits) == 0) {
            owned.at(std::to_underlying(requested.from)) |= bits;
            taken |= bits;
        }
    }
    return owned;
}

// Down at the start of the tick: the game's first step for the button says what it changed from;
// without one, the word is the state throughout.
auto was_held(const game_command& game, u64 bit) -> bool {
    const auto first = std::ranges::find_if(game.steps, [bit](const subtick_step& step) {
        return touches(step, bit);
    });
    if (first != game.steps.end()) {
        return !is_pressed(*first);
    }
    return (game.buttons.held & bit) != 0;
}

auto buttons_after(const game_command& game, std::span<const subtick_step> steps, u64 claimed)
    -> button_state {
    button_state words = game.buttons;
    for (u64 rest = claimed; rest != 0; rest &= rest - 1) {
        const u64 bit = rest & (~rest + 1);
        bool is_down = was_held(game, bit);
        bool has_changed = false;
        for (const subtick_step& step : steps) {
            if (touches(step, bit)) {
                has_changed = has_changed || is_pressed(step) != is_down;
                is_down = is_pressed(step);
            }
        }
        words.held = is_down ? (words.held | bit) : (words.held & ~bit);
        words.changed = has_changed ? (words.changed | bit) : (words.changed & ~bit);
    }
    return words;
}

}

auto emit(std::span<const subtick_step> kept, std::span<const stage_request> requests)
    -> std::expected<std::vector<subtick_step>, step_refusal> {
    std::vector<subtick_step> steps{kept.begin(), kept.end()};
    for (const stage_request& requested : requests) {
        const subtick_step made = LUCENT_TRY(checked(requested));
        if (is_button_change(made) && meets_opposite(steps, made)) {
            return std::unexpected(refusal(refusal_reason::press_meets_release, requested));
        }
        if (std::ssize(steps) >= max_steps) {
            return std::unexpected(refusal(refusal_reason::too_many_steps, requested));
        }
        steps.push_back(made);
    }
    std::ranges::stable_sort(steps, {}, &subtick_step::when);
    return steps;
}

auto plan_command(const game_command& game, std::span<const stage_request> requests) -> planned {
    const std::vector<u64> owned = owned_bits(requests);
    u64 claimed = 0;
    bool has_analog = false;
    planned outcome;
    std::vector<stage_request> accepted;
    for (const stage_request& requested : requests) {
        const std::optional<u64> pressed = button_of(requested.step);
        if (!pressed) {
            has_analog = true;
            accepted.push_back(requested);
            continue;
        }
        const u64 bits = *pressed;
        if ((owned.at(std::to_underlying(requested.from)) & bits) != bits) {
            outcome.refusals.push_back(refusal(refusal_reason::taken_by_earlier_stage, requested));
            continue;
        }
        claimed |= bits;
        accepted.push_back(requested);
    }
    std::vector<subtick_step> kept;
    for (const subtick_step& step : game.steps) {
        const bool is_claimed = touches(step, claimed);
        if (!is_claimed && !(has_analog && is_analog_only(step))) {
            kept.push_back(step);
        }
    }
    std::expected<std::vector<subtick_step>, step_refusal> steps = emit(kept, accepted);
    if (!steps) {
        outcome.refusals.push_back(steps.error());
        return outcome;
    }
    outcome.plan = command_plan{
        .buttons = buttons_after(game, *steps, claimed),
        .steps = std::move(*steps),
    };
    return outcome;
}

}
