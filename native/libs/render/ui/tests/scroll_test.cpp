#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>

#include "fixture.hpp"

namespace lucent::ui {
namespace {

auto sized(size_rule width, size_rule height) -> box_style {
    return {
        .flow = direction::column,
        .width = width,
        .height = height,
        .gap = 0.0F,
        .main = main_align::start,
        .cross = cross_align::start,
    };
}

// An outer scroll 200 tall over 1000 of content, whose first 100 are an inner scroll over 500.
constexpr element_id outer = child_id(root_id(key<"window">()), key<"outer">());
constexpr element_id inner = child_id(outer, key<"inner">());
constexpr element_id inner_top = child_id(inner, key<"inner top">());
constexpr element_id outer_top = child_id(outer, key<"outer top">());

auto declare(context& frame) -> void {
    frame.window(
        {
            .key = key<"window">(),
            .position = {.x = 0.0F, .y = 100.0F},
            .style = sized(fixed(300.0F), fixed(200.0F)),
        },
        [&] {
            frame.scroll(key<"outer">(), sized(grow(), grow()), [&] {
                frame.scroll(key<"inner">(), sized(grow(), fixed(100.0F)), [&] {
                    frame.box(key<"inner top">(), sized(grow(), fixed(500.0F)), [] {});
                });
                frame.box(key<"outer top">(), sized(grow(), fixed(900.0F)), [] {});
            });
        }
    );
}

auto wheel(draw::vec2 cursor, f32 notches) -> input_snapshot {
    input_snapshot input = testing::hover(cursor);
    input.wheel = {.x = 0.0F, .y = notches};
    return input;
}

TEST_CASE("the wheel scrolls the innermost scroll under the cursor, and stops at its end") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    context& frame = run.ui();
    run.step([&] { declare(frame); });
    const f32 step = frame.tokens().controls.wheel_step;

    run.step(wheel({.x = 50.0F, .y = 150.0F}, -1.0F), [&] { declare(frame); });
    CHECK(testing::rect_of(frame, inner_top).min.y + step == 100.0F);
    CHECK(testing::rect_of(frame, outer_top).min.y == 200.0F);

    run.step(wheel({.x = 50.0F, .y = 150.0F}, -100.0F), [&] { declare(frame); });
    CHECK(testing::rect_of(frame, inner_top).min.y + 400.0F == 100.0F);

    run.step(wheel({.x = 50.0F, .y = 250.0F}, -1.0F), [&] { declare(frame); });
    CHECK(testing::rect_of(frame, outer_top).min.y + step == 200.0F);
    CHECK(testing::rect_of(frame, inner).min.y + step == 100.0F);
}

TEST_CASE("scrolling is smooth: the offset approaches the wheel's target over frames") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    run.step([&] { declare(frame); });
    const f32 step = frame.tokens().controls.wheel_step;

    run.step(wheel({.x = 50.0F, .y = 250.0F}, -1.0F), [&] { declare(frame); });
    const f32 first = 200.0F - testing::rect_of(frame, outer_top).min.y;
    CHECK(first > 0.0F);
    CHECK(first < step);
    for (isize tick = 0; tick < 60; ++tick) {
        run.step([&] { declare(frame); });
    }
    CHECK(200.0F - testing::rect_of(frame, outer_top).min.y > step - 0.01F);
}

TEST_CASE("the wheel over a root above a scroll leaves the scroll alone") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    context& frame = run.ui();
    const auto declare_covered = [&] {
        declare(frame);
        frame.window(
            {
                .key = key<"cover">(),
                .position = {.x = 0.0F, .y = 220.0F},
                .style = sized(fixed(300.0F), fixed(50.0F)),
            },
            [] {}
        );
    };
    run.step(declare_covered);

    run.step(wheel({.x = 50.0F, .y = 250.0F}, -1.0F), declare_covered);
    CHECK(testing::rect_of(frame, outer_top).min.y == 200.0F);
}

TEST_CASE("an element scrolled out of its scroll's view can't be hit") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    context& frame = run.ui();
    interaction hit;
    const auto declare_padded = [&] {
        box_style padded = sized(fixed(300.0F), fixed(300.0F));
        padded.padding = even(50.0F);
        frame.window(
            {.key = key<"window">(), .position = {.x = 0.0F, .y = 100.0F}, .style = padded}, [&] {
                frame.scroll(key<"list">(), sized(grow(), grow()), [&] {
                    hit = frame.interact(frame.id_of(key<"row">()), flags{sense::click});
                    frame.box(key<"row">(), sized(grow(), fixed(40.0F)), [] {});
                    frame.box(key<"rest">(), sized(grow(), fixed(1000.0F)), [] {});
                });
            }
        );
    };
    run.step(declare_padded);
    run.step(wheel({.x = 100.0F, .y = 200.0F}, -0.5F), declare_padded);
    REQUIRE(testing::rect_of(frame, hit.id).min.y < 140.0F);

    run.step(testing::hover({.x = 100.0F, .y = 145.0F}), declare_padded);
    CHECK_FALSE(hit.is_hovered);
    run.step(testing::hover({.x = 100.0F, .y = 155.0F}), declare_padded);
    CHECK(hit.is_hovered);
}

TEST_CASE("dragging the rail's thumb scrolls in step with the hand") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    run.step([&] { declare(frame); });
    const draw::rect area = testing::rect_of(frame, outer);
    // 200 of 1000 shown: the thumb is 40 long and travels 160 over 800 of scrolling.
    const draw::vec2 thumb{.x = area.max.x - 1.0F, .y = area.min.y + 20.0F};

    run.step(testing::press(thumb), [&] { declare(frame); });
    CHECK(run.report().wants_mouse);
    run.step(testing::hold(thumb + draw::vec2{.x = -100.0F, .y = 80.0F}), [&] { declare(frame); });
    CHECK(testing::rect_of(frame, outer_top).min.y + 400.0F == 200.0F);
    run.step(testing::release(thumb + draw::vec2{.x = 0.0F, .y = 500.0F}), [&] { declare(frame); });
    CHECK(testing::rect_of(frame, outer_top).min.y + 800.0F == 200.0F);
}

TEST_CASE("a press on the rail away from the thumb centres the thumb there") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    context& frame = run.ui();
    run.step([&] { declare(frame); });
    const draw::rect area = testing::rect_of(frame, outer);
    run.step(testing::press({.x = area.max.x - 1.0F, .y = area.min.y + 100.0F}), [&] {
        declare(frame);
    });
    // The thumb's top at 80 of its 160 of travel: halfway.
    CHECK(testing::rect_of(frame, outer_top).min.y + 400.0F == 200.0F);
}

}
}
