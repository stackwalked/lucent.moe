#include <lucent/ui/motion.hpp>

#include <array>
#include <chrono>
#include <cmath>

#include <catch2/catch_test_macros.hpp>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/theme.hpp>

#include "fixture.hpp"

namespace lucent::ui {
namespace {

constexpr auto is_near(f32 value, f32 expected) -> bool {
    const f32 difference = value - expected;
    return difference < 0.0001F && difference > -0.0001F;
}

static_assert(is_near(eased(easing::linear, 0.25F), 0.25F));
static_assert(is_near(eased(easing::out_cubic, 0.0F), 0.0F));
static_assert(is_near(eased(easing::out_cubic, 1.0F), 1.0F));
static_assert(is_near(eased(easing::out_cubic, 0.5F), 0.875F));
static_assert(is_near(eased(easing::in_out_cubic, 0.5F), 0.5F));
static_assert(is_near(eased(easing::in_out_cubic, 0.25F), 0.0625F), "slow out of the start");
static_assert(is_near(eased(easing::out_cubic, 2.0F), 1.0F), "progress past the end holds there");

constexpr std::chrono::milliseconds half_life{100};
constexpr std::chrono::milliseconds two_half_lives{200};
constexpr std::chrono::milliseconds response{300};
constexpr std::chrono::milliseconds frame_step{16};
constexpr std::chrono::milliseconds instant{0};

TEST_CASE("approach halves the distance to its target every half-life") {
    const f32 once = approached(0.0F, {.target = 1.0F, .timing = half_life, .elapsed = half_life});
    const f32 twice =
        approached(0.0F, {.target = 1.0F, .timing = half_life, .elapsed = two_half_lives});
    CHECK(is_near(once, 0.5F));
    CHECK(is_near(twice, 0.75F));
    CHECK(approached(0.0F, {.target = 1.0F, .timing = instant, .elapsed = frame_step}) == 1.0F);
}

auto spring_after(isize frames, std::chrono::milliseconds each) -> spring_value {
    spring_value value;
    for (isize tick = 0; tick < frames; ++tick) {
        value = sprung(value, {.target = 1.0F, .timing = response, .elapsed = each});
    }
    return value;
}

TEST_CASE("a critically damped spring settles on its target without overshooting") {
    spring_value value;
    f32 previous = 0.0F;
    for (isize tick = 0; tick < 120; ++tick) {
        value = sprung(value, {.target = 1.0F, .timing = response, .elapsed = frame_step});
        CHECK(value.position >= previous);
        CHECK(value.position <= 1.0F);
        previous = value.position;
    }
    CHECK(value.position > 0.999F);
}

TEST_CASE("a spring moves alike at any frame rate") {
    const spring_value slow = spring_after(5, std::chrono::milliseconds{40});
    const spring_value fast = spring_after(40, std::chrono::milliseconds{5});
    CHECK(std::abs(slow.position - fast.position) < 0.01F);
}

TEST_CASE("a retargeted spring keeps its velocity rather than restarting") {
    spring_value value;
    for (isize tick = 0; tick < 5; ++tick) {
        value = sprung(value, {.target = 1.0F, .timing = response, .elapsed = frame_step});
    }
    const spring_value turned =
        sprung(value, {.target = 0.0F, .timing = response, .elapsed = frame_step});
    CHECK(value.velocity > 0.0F);
    CHECK(turned.position > value.position);
}

TEST_CASE("a tween restarts from where it is and runs the theme's duration on the input clock") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    const element_id moved = root_id(key<"moved">());
    f32 value = 0.0F;
    run.step([&] { value = frame.tween(moved, 0.0F); });
    const std::chrono::milliseconds duration = frame.tokens().motion.normal;
    run.step([&] { value = frame.tween(moved, 1.0F); });
    CHECK(value == 0.0F);

    run.wait(duration / 2 - std::chrono::milliseconds{16});
    run.step([&] { value = frame.tween(moved, 1.0F); });
    CHECK(is_near(value, eased(frame.tokens().motion.standard, 0.5F)));
    run.wait(duration);
    run.step([&] { value = frame.tween(moved, 1.0F); });
    CHECK(value == 1.0F);
}

auto presence_after(testing::driver& run, visibility wanted, isize frames) -> f32 {
    context& frame = run.ui();
    const element_id shown = root_id(key<"shown">());
    f32 value = 0.0F;
    for (isize tick = 0; tick < frames; ++tick) {
        run.step([&] { value = frame.presence(shown, wanted); });
    }
    return value;
}

TEST_CASE("presence rises from 0 on enter") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    CHECK(presence_after(run, visibility::shown, 1) == 0.0F);
    const f32 rising = presence_after(run, visibility::shown, 1);
    CHECK(rising > 0.0F);
    CHECK(rising < 1.0F);
    CHECK(presence_after(run, visibility::shown, 10) == 1.0F);
}

TEST_CASE("presence falls back to 0 on exit") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    CHECK(presence_after(run, visibility::shown, 12) == 1.0F);
    const f32 falling = presence_after(run, visibility::hidden, 1);
    CHECK(falling < 1.0F);
    CHECK(falling > 0.0F);
    CHECK(presence_after(run, visibility::hidden, 10) == 0.0F);
}

TEST_CASE("reduced motion zeroes every duration") {
    const testing::fixture_text fixture = testing::plex_text();
    const theme reduced = testing::test_theme(fixture.plex, testing::motion_preference::reduced);
    CHECK(reduced.motion.approach_half_life.count() == 0);
    CHECK(reduced.motion.spring_response.count() == 0);
    CHECK(reduced.motion.fast.count() == 0);
    CHECK(reduced.motion.normal.count() == 0);
}

TEST_CASE("reduced motion snaps every primitive to its target") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    context& frame = run.ui();
    const element_id approaching = root_id(key<"approaching">());
    const element_id springing = root_id(key<"springing">());
    const element_id tweening = root_id(key<"tweening">());
    std::array<f32, 3> values{};
    run.step([&] {
        values = {
            frame.approach(approaching, 0.0F),
            frame.spring(springing, 0.0F),
            frame.tween(tweening, 0.0F),
        };
    });
    run.step([&] {
        values = {
            frame.approach(approaching, 1.0F),
            frame.spring(springing, 1.0F),
            frame.tween(tweening, 1.0F),
        };
    });
    CHECK(values == std::array{1.0F, 1.0F, 1.0F});
    CHECK(presence_after(run, visibility::shown, 1) == 1.0F);
}

}
}
