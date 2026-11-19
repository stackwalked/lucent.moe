#include <lucent/cs2-domains/command.hpp>

#include <bit>
#include <expected>
#include <limits>
#include <optional>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>

// What the command carries is what the server simulates: a step out of order, a press and a
// release at one moment, or a stage's button taken by another, are wrong inputs nothing reports.
// These check emit's rules and the one conflict rule against commands worked out by hand.

namespace lucent::cs2 {
namespace {

constexpr u64 attack = u64{std::to_underlying(button::attack)};
constexpr u64 jump = u64{std::to_underlying(button::jump)};

// A command the game left alone: no buttons, no steps.
auto untouched() -> game_command {
    return {.buttons = {.held = 0, .changed = 0, .scroll = 0}, .steps = {}};
}

auto press(stage from, button which, f32 when) -> stage_request {
    return {.from = from, .step = button_step{.which = which, .change = edge::press, .when = when}};
}

auto release(stage from, button which, f32 when) -> stage_request {
    return {
        .from = from,
        .step = button_step{.which = which, .change = edge::release, .when = when},
    };
}

auto game_step(u64 buttons, edge change, f32 when) -> subtick_step {
    return {
        .when = when,
        .buttons = buttons,
        .is_pressed = change == edge::press,
        .forward = std::nullopt,
        .left = std::nullopt,
        .pitch = std::nullopt,
        .yaw = std::nullopt,
    };
}

auto analog_only(f32 when) -> subtick_step {
    return {
        .when = when,
        .buttons = std::nullopt,
        .is_pressed = std::nullopt,
        .forward = 1.0F,
        .left = std::nullopt,
        .pitch = std::nullopt,
        .yaw = std::nullopt,
    };
}

// The same step, bit for bit.
auto is_same_step(const subtick_step& first, const subtick_step& second) -> bool {
    const auto bits = [](std::optional<f32> value) {
        return value.transform([](f32 held) { return std::bit_cast<u32>(held); });
    };
    return std::bit_cast<u32>(first.when) == std::bit_cast<u32>(second.when)
           && first.buttons == second.buttons
           && first.is_pressed == second.is_pressed
           && bits(first.forward) == bits(second.forward)
           && bits(first.left) == bits(second.left)
           && bits(first.pitch) == bits(second.pitch)
           && bits(first.yaw) == bits(second.yaw);
}

// The request a refusal names, as the button it asked for and when.
auto refused_moment(const step_refusal& refused) -> f32 {
    return match(refused.refused.step, [](const auto& step) { return step.when; });
}

auto reason_of(const std::expected<std::vector<subtick_step>, step_refusal>& emitted)
    -> std::optional<refusal_reason> {
    return emitted ? std::nullopt : std::optional{emitted.error().reason};
}

}

TEST_CASE("emit rounds a requested moment to the 64th and orders it among the game's steps") {
    const std::vector kept{
        game_step(jump, edge::press, 0.1F),
        game_step(jump, edge::release, 0.7F),
    };
    const std::vector requests{press(stage::trigger, button::attack, 0.33F)};

    const auto emitted = emit(kept, requests);

    REQUIRE(emitted.has_value());
    REQUIRE(emitted->size() == 3);
    CHECK(is_same_step(emitted->at(0), kept.at(0)));
    CHECK(emitted->at(1).when == 0.328125F);
    CHECK(emitted->at(1).buttons == attack);
    CHECK(emitted->at(1).is_pressed == true);
    CHECK(is_same_step(emitted->at(2), kept.at(1)));
}

TEST_CASE("emit refuses a moment outside the tick, including one that rounds to its end") {
    CHECK(
        reason_of(emit({}, std::vector{press(stage::trigger, button::attack, -0.01F)}))
        == refusal_reason::outside_tick
    );
    CHECK(
        reason_of(emit({}, std::vector{press(stage::trigger, button::attack, 0.995F)}))
        == refusal_reason::outside_tick
    );
    CHECK(
        reason_of(emit(
            {},
            std::vector{press(stage::trigger, button::attack, std::numeric_limits<f32>::infinity())}
        ))
        == refusal_reason::outside_tick
    );
}

TEST_CASE("emit refuses a step carrying no button or several") {
    const stage_request both{
        .from = stage::scripts,
        .step = button_step{
            // NOLINTNEXTLINE(clang-analyzer-optin.core.EnumCastOutOfRange): two bits are no button; emit must refuse it.
            .which = static_cast<button>(attack | jump),
            .change = edge::press,
            .when = 0.0F,
        },
    };

    CHECK(reason_of(emit({}, std::vector{both})) == refusal_reason::not_one_button);
}

TEST_CASE("emit refuses a press and a release at one moment, the game's steps included") {
    const std::vector kept{game_step(jump, edge::release, 0.5F)};

    CHECK(
        reason_of(emit(kept, std::vector{press(stage::trigger, button::attack, 0.5F)}))
        == refusal_reason::press_meets_release
    );
    CHECK(
        reason_of(emit(
            {},
            std::vector{
                press(stage::trigger, button::attack, 0.25F),
                release(stage::trigger, button::attack, 0.25F),
            }
        ))
        == refusal_reason::press_meets_release
    );
    CHECK(emit(kept, std::vector{release(stage::trigger, button::attack, 0.5F)}).has_value());
}

TEST_CASE("emit refuses the step that would take the command past thirty") {
    const std::vector<subtick_step> kept(29, analog_only(0.0F));
    const std::vector requests{
        press(stage::trigger, button::attack, 0.25F),
        release(stage::trigger, button::attack, 0.5F),
    };

    const auto emitted = emit(kept, requests);

    REQUIRE_FALSE(emitted);
    CHECK(emitted.error().reason == refusal_reason::too_many_steps);
    CHECK(refused_moment(emitted.error()) == 0.5F);
}

TEST_CASE("emit refuses an analog change past a whole key's swing") {
    const stage_request swung{
        .from = stage::movement,
        .step = analog_step{.when = 0.0F, .forward = 1.5F, .left = 0.0F},
    };

    CHECK(reason_of(emit({}, std::vector{swung})) == refusal_reason::over_analog_cap);
}

TEST_CASE("a button goes to the earliest stage asking for it, and the later one is refused") {
    const std::vector requests{
        press(stage::trigger, button::attack, 0.0F),
        press(stage::aim_shot, button::attack, 0.5F),
    };

    const planned outcome = plan_command(untouched(), requests);

    REQUIRE(outcome.plan.has_value());
    const command_plan plan = outcome.plan.value_or(command_plan{});
    REQUIRE(plan.steps.size() == 1);
    CHECK(plan.steps.front().when == 0.5F);
    REQUIRE(outcome.refusals.size() == 1);
    CHECK(outcome.refusals.front().reason == refusal_reason::taken_by_earlier_stage);
    CHECK(outcome.refusals.front().refused.from == stage::trigger);
}

TEST_CASE("a stage that takes a button drops the game's steps for it and keeps the rest") {
    const game_command game{
        .buttons = {.held = attack | jump, .changed = attack, .scroll = 0},
        .steps = {game_step(attack, edge::press, 0.2F), game_step(jump, edge::press, 0.4F)},
    };

    const planned outcome =
        plan_command(game, std::vector{release(stage::aim_shot, button::attack, 0.0F)});

    REQUIRE(outcome.plan.has_value());
    const command_plan plan = outcome.plan.value_or(command_plan{});
    REQUIRE(plan.steps.size() == 2);
    CHECK(plan.steps.at(0).buttons == attack);
    CHECK(plan.steps.at(0).is_pressed == false);
    CHECK(is_same_step(plan.steps.at(1), game.steps.at(1)));
    // Up before the game's press at 0.2, and the release changes nothing.
    CHECK((plan.buttons.held & attack) == 0);
    CHECK((plan.buttons.changed & attack) == 0);
    CHECK((plan.buttons.held & jump) == jump);
}

TEST_CASE("a press of a button that was up leaves it down and changed") {
    const planned outcome =
        plan_command(untouched(), std::vector{press(stage::trigger, button::attack, 0.0F)});

    REQUIRE(outcome.plan.has_value());
    const command_plan plan = outcome.plan.value_or(command_plan{});
    CHECK(plan.buttons.held == attack);
    CHECK(plan.buttons.changed == attack);
}

TEST_CASE("a click within the tick leaves the button up but changed") {
    const game_command held{
        .buttons = {.held = 0, .changed = 0, .scroll = 0},
        .steps = {},
    };

    const planned outcome = plan_command(
        held,
        std::vector{
            press(stage::aim_shot, button::attack, 0.0F),
            release(stage::aim_shot, button::attack, 0.5F),
        }
    );

    REQUIRE(outcome.plan.has_value());
    const command_plan plan = outcome.plan.value_or(command_plan{});
    CHECK((plan.buttons.held & attack) == 0);
    CHECK((plan.buttons.changed & attack) == attack);
}

TEST_CASE("a refused emit leaves the command as the game built it, and says why") {
    const game_command game{
        .buttons = {.held = jump, .changed = 0, .scroll = 0},
        .steps = {game_step(jump, edge::press, 0.5F)},
    };

    const planned outcome =
        plan_command(game, std::vector{release(stage::trigger, button::attack, 0.5F)});

    CHECK_FALSE(outcome.plan);
    REQUIRE(outcome.refusals.size() == 1);
    CHECK(outcome.refusals.front().reason == refusal_reason::press_meets_release);
}

TEST_CASE("an analog request drops the game's analog-only steps") {
    const game_command game{
        .buttons = {.held = 0, .changed = 0, .scroll = 0},
        .steps = {analog_only(0.1F), game_step(jump, edge::press, 0.3F)},
    };
    const stage_request moved{
        .from = stage::movement,
        .step = analog_step{.when = 0.5F, .forward = -1.0F, .left = 0.0F},
    };

    const planned outcome = plan_command(game, std::vector{moved});

    REQUIRE(outcome.plan.has_value());
    const command_plan plan = outcome.plan.value_or(command_plan{});
    REQUIRE(plan.steps.size() == 2);
    CHECK(is_same_step(plan.steps.at(0), game.steps.at(1)));
    CHECK(plan.steps.at(1).forward == -1.0F);
}

}
