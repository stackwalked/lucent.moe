#include <lucent/cs2-overlay/overlay_state.hpp>

#include <catch2/catch_test_macros.hpp>

#include <lucent/testing/invariant_violation.hpp>

// In the game a wrong transition shows only as an overlay that never appears, draws with an empty
// atlas, or drops a renderer a worker is still building.

namespace lucent::cs2::overlay {
namespace {

constexpr device_id first_device{0x1000};
constexpr device_id second_device{0x2000};

// A state whose renderer for first_device is built and has drawn once.
auto drawing() -> overlay_state {
    overlay_state state;
    LUCENT_INVARIANT(state.frame(first_device) == frame_action::start_over);
    state.landed(build_outcome::ready);
    LUCENT_INVARIANT(state.frame(first_device) == frame_action::draw_with_atlas);
    return state;
}

TEST_CASE("the overlay stays off until the first build lands ready") {
    overlay_state state;

    CHECK(state.frame(first_device) == frame_action::start_over);
    CHECK(state.frame(first_device) == frame_action::none);
    CHECK(state.frame(first_device) == frame_action::none);
    state.landed(build_outcome::ready);
    CHECK(state.frame(first_device) == frame_action::draw_with_atlas);
}

TEST_CASE("the whole atlas goes to a renderer on its first frame only") {
    overlay_state state = drawing();

    CHECK(state.frame(first_device) == frame_action::draw);
    CHECK(state.frame(first_device) == frame_action::draw);
}

TEST_CASE("a new device starts over, and its renderer gets the whole atlas again") {
    overlay_state state = drawing();

    CHECK(state.frame(second_device) == frame_action::start_over);
    CHECK(state.frame(second_device) == frame_action::none);
    state.landed(build_outcome::ready);
    CHECK(state.frame(second_device) == frame_action::draw_with_atlas);
}

TEST_CASE("a new device waits for a renderer still building, then starts over") {
    overlay_state state;
    REQUIRE(state.frame(first_device) == frame_action::start_over);

    CHECK(state.frame(second_device) == frame_action::none);
    state.landed(build_outcome::ready);
    CHECK(state.frame(second_device) == frame_action::start_over);
}

TEST_CASE("a failed build is tried again on the next frame") {
    overlay_state state;
    REQUIRE(state.frame(first_device) == frame_action::start_over);

    state.landed(build_outcome::retry);
    CHECK(state.frame(first_device) == frame_action::build);
    CHECK(state.frame(first_device) == frame_action::none);
    state.landed(build_outcome::ready);
    CHECK(state.frame(first_device) == frame_action::draw_with_atlas);
}

TEST_CASE("a renderer that gave up stays off until a new device") {
    overlay_state state;
    REQUIRE(state.frame(first_device) == frame_action::start_over);

    state.landed(build_outcome::given_up);
    CHECK(state.frame(first_device) == frame_action::none);
    CHECK(state.frame(first_device) == frame_action::none);
    CHECK(state.frame(second_device) == frame_action::start_over);
}

TEST_CASE("turned off, the overlay stays off for the session, new devices included") {
    overlay_state state = drawing();

    state.turn_off();

    CHECK(state.frame(first_device) == frame_action::none);
    CHECK(state.frame(second_device) == frame_action::none);
}

TEST_CASE("a build landing after the overlay was turned off leaves it off") {
    overlay_state state;
    REQUIRE(state.frame(first_device) == frame_action::start_over);

    state.turn_off();
    state.landed(build_outcome::ready);

    CHECK(state.frame(first_device) == frame_action::none);
}

TEST_CASE("a build landing when none was started is a bug in the glue") {
    overlay_state state = drawing();

    CHECK_THROWS_AS(state.landed(build_outcome::ready), testing::invariant_violation);
}

}
}
