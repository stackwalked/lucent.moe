#include <array>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
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

// A window whose whole area is one clickable element.
auto clickable_window(context& frame, local_key key, draw::vec2 position) -> interaction {
    interaction hit;
    frame.window(
        {.key = key, .position = position, .style = sized(fixed(200.0F), fixed(200.0F))}, [&] {
            hit = frame.interact(frame.id_of(ui::key<"area">()), flags{sense::click});
            frame.box(ui::key<"area">(), sized(grow(), grow()), [] {});
        }
    );
    return hit;
}

struct two_windows {
    interaction below;
    interaction above;
};

auto declare(context& frame, two_windows& windows) -> void {
    windows.below = clickable_window(frame, key<"below">(), {.x = 0.0F, .y = 0.0F});
    windows.above = clickable_window(frame, key<"above">(), {.x = 100.0F, .y = 100.0F});
}

auto click(testing::driver& run, draw::vec2 where, two_windows& windows) -> void {
    context& frame = run.ui();
    run.step(testing::press(where), [&] { declare(frame, windows); });
    run.step(testing::release(where), [&] { declare(frame, windows); });
}

TEST_CASE("input goes to the topmost root under the cursor, and a press raises its window") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    two_windows windows;
    constexpr draw::vec2 overlap{.x = 150.0F, .y = 150.0F};
    run.step([&] { declare(frame, windows); });

    click(run, overlap, windows);
    CHECK(windows.above.is_activated);
    CHECK_FALSE(windows.below.is_activated);

    click(run, {.x = 50.0F, .y = 50.0F}, windows);
    CHECK(windows.below.is_activated);
    click(run, overlap, windows);
    CHECK(windows.below.is_activated);
    CHECK_FALSE(windows.above.is_activated);
}

// A window holding an anchor, a popup on it holding a second anchor, and a popup on that.
constexpr element_id outer_anchor = child_id(root_id(key<"window">()), key<"anchor">());
constexpr element_id inner_anchor = child_id(popup_id(outer_anchor), key<"inner">());

struct nested_popups {
    interaction outer_hit;
    bool should_open_outer = false;
    bool should_open_inner = false;
};

auto declare(context& frame, nested_popups& popups) -> void {
    frame.window(
        {
            .key = key<"window">(),
            .position = {.x = 10.0F, .y = 10.0F},
            .style = sized(fixed(300.0F), fixed(300.0F)),
        },
        [&] {
            frame.box(key<"anchor">(), sized(fixed(120.0F), fixed(30.0F)), [] {});
            if (popups.should_open_outer) {
                frame.open_popup(outer_anchor);
            }
        }
    );
    frame.popup(outer_anchor, sized(fit(), fit()), [&] {
        popups.outer_hit = frame.interact(inner_anchor, flags{sense::click});
        frame.box(key<"inner">(), sized(grow(), fixed(40.0F)), [] {});
        if (popups.should_open_inner) {
            frame.open_popup(inner_anchor);
        }
    });
    frame.popup(inner_anchor, sized(fixed(50.0F), fixed(50.0F)), [] {});
    popups.should_open_outer = false;
    popups.should_open_inner = false;
}

auto open_both(testing::driver& run, nested_popups& popups) -> void {
    context& frame = run.ui();
    popups.should_open_outer = true;
    run.step([&] { declare(frame, popups); });
    popups.should_open_inner = true;
    run.step([&] { declare(frame, popups); });
}

TEST_CASE("popups nest, and escape closes only the top one") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    nested_popups popups;
    open_both(run, popups);
    REQUIRE(frame.is_popup_open(outer_anchor));
    REQUIRE(frame.is_popup_open(inner_anchor));

    const input_snapshot escape = testing::keys({testing::pressed(key_code::escape)});
    run.step(escape, [&] { declare(frame, popups); });
    CHECK(frame.is_popup_open(outer_anchor));
    CHECK_FALSE(frame.is_popup_open(inner_anchor));
    run.step(escape, [&] { declare(frame, popups); });
    CHECK_FALSE(frame.is_popup_open(outer_anchor));
}

TEST_CASE("a popup sits below its anchor, at least as wide") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    const context& frame = run.ui();
    nested_popups popups;
    open_both(run, popups);

    const f32 gap = frame.tokens().controls.popup_gap;
    CHECK(
        testing::edges(frame.rect(inner_anchor))
        == std::array{10.0F, 40.0F + gap, 130.0F, 80.0F + gap}
    );
    CHECK(
        testing::edges(frame.rect(popup_id(inner_anchor)))
        == std::array{10.0F, 80.0F + (2.0F * gap), 130.0F, 130.0F + (2.0F * gap)}
    );
}

TEST_CASE("a press inside a popup goes to it and keeps it open; a press outside closes it") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    nested_popups popups;
    popups.should_open_outer = true;
    run.step([&] { declare(frame, popups); });
    run.step([&] { declare(frame, popups); });
    const draw::vec2 inside = testing::centre(testing::rect_of(frame, inner_anchor));

    run.step(testing::press(inside), [&] { declare(frame, popups); });
    run.step(testing::release(inside), [&] { declare(frame, popups); });
    CHECK(popups.outer_hit.is_activated);
    CHECK(frame.is_popup_open(outer_anchor));

    run.step(testing::press({.x = 250.0F, .y = 250.0F}), [&] { declare(frame, popups); });
    CHECK_FALSE(frame.is_popup_open(outer_anchor));
}

TEST_CASE("a popup its code stops declaring closes") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    nested_popups popups;
    popups.should_open_outer = true;
    run.step([&] { declare(frame, popups); });
    REQUIRE(frame.is_popup_open(outer_anchor));

    run.step([&] {
        frame.window(
            {
                .key = key<"window">(),
                .position = {.x = 0.0F, .y = 0.0F},
                .style = sized(fixed(10.0F), fixed(10.0F)),
            },
            [] {}
        );
    });
    CHECK_FALSE(frame.is_popup_open(outer_anchor));
}

}
}
