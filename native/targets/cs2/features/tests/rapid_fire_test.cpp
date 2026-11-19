#include <lucent/cs2-features/rapid_fire.hpp>

#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>
#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/command_board.hpp>
#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/command_stages.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>

// A press that never comes, or a release while the player still holds, fires nothing or fires
// once: the member just sees a gun that doesn't shoot as fast as it should. Checked against the
// requests a few ticks of held attack make.

namespace lucent::cs2::features {
namespace {

constexpr u64 attack = u64{std::to_underlying(button::attack)};

// One tick's parts, as the command domain hands them over, and what the feature asked for.
auto requests_of(rapid_fire& running, i64 tick, u64 held) -> std::vector<button_step> {
    const command_input input{
        .tick = tick,
        .game = {.buttons = {.held = held, .changed = 0, .scroll = 0}, .steps = {}},
        .refusals = {},
    };
    command_board board;
    const aim_shot_stage shot{board};
    kit::view_set parts;
    parts.put(input);
    parts.put(shot);
    const kit::no_settings chosen;
    running.tick(kit::context<rapid_fire>{parts, chosen});
    std::vector<button_step> asked;
    for (const stage_request& requested : board.requests()) {
        CHECK(requested.from == stage::aim_shot);
        match(
            requested.step,
            [&asked](const button_step& pressed) { asked.push_back(pressed); },
            [](const analog_step& /*moved*/) { FAIL("rapid fire asked for an analog change"); }
        );
    }
    return asked;
}

}

TEST_CASE("held attack goes in as a press one tick and a release the next") {
    rapid_fire running;

    const std::vector<button_step> first = requests_of(running, 10, attack);
    const std::vector<button_step> second = requests_of(running, 11, attack);
    const std::vector<button_step> third = requests_of(running, 12, attack);

    REQUIRE(first.size() == 1);
    CHECK(first.front().which == button::attack);
    CHECK(first.front().change == edge::press);
    REQUIRE(second.size() == 1);
    CHECK(second.front().change == edge::release);
    REQUIRE(third.size() == 1);
    CHECK(third.front().change == edge::press);
}

TEST_CASE("without the player's attack it asks for nothing") {
    rapid_fire running;

    CHECK(requests_of(running, 10, 0).empty());
    CHECK(requests_of(running, 11, std::to_underlying(button::jump)).empty());
}

TEST_CASE("after a gap in the ticks held attack starts with a press") {
    rapid_fire running;
    std::ignore = requests_of(running, 10, attack);

    const std::vector<button_step> later = requests_of(running, 20, attack);

    REQUIRE(later.size() == 1);
    CHECK(later.front().change == edge::press);
}

}
