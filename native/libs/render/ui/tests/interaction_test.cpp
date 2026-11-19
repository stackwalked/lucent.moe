#include <lucent/ui/interaction.hpp>

#include <optional>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/button.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>

#include "fixture.hpp"

namespace lucent::ui {
namespace {

constexpr draw::vec2 outside{.x = 700.0F, .y = 500.0F};

auto column() -> window_spec {
    return {
        .key = key<"window">(),
        .position = {.x = 0.0F, .y = 0.0F},
        .style = {
            .flow = direction::column,
            .width = fixed(200.0F),
            .height = fit(),
            .gap = 0.0F,
            .main = main_align::start,
            .cross = cross_align::start,
        },
    };
}

// Three buttons, a to c, in a column, and what each did this frame.
struct three_buttons {
    interaction a;
    interaction b;
    interaction c;
};

auto declare(context& frame, three_buttons& buttons) -> void {
    frame.window(column(), [&] {
        buttons.a = button(frame, key<"a">(), "Apply");
        buttons.b = button(frame, key<"b">(), "Back");
        buttons.c = button(frame, key<"c">(), "Cancel");
    });
}

auto with_shift(input_snapshot input) -> input_snapshot {
    input.modifiers = flags{modifier::shift};
    return input;
}

TEST_CASE("a click is a press and then a release over the same element") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });
    const draw::vec2 on_a = testing::centre(testing::rect_of(frame, buttons.a.id));

    run.step(testing::press(on_a), [&] { declare(frame, buttons); });
    CHECK(buttons.a.is_pressed);
    CHECK(buttons.a.is_just_pressed);
    CHECK_FALSE(buttons.a.is_activated);

    run.step(testing::release(on_a), [&] { declare(frame, buttons); });
    CHECK(buttons.a.is_activated);
    CHECK(buttons.a.is_hovered);
    CHECK_FALSE(buttons.b.is_activated);
}

TEST_CASE("a release away from the pressed element clicks nothing") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });
    const draw::vec2 on_a = testing::centre(testing::rect_of(frame, buttons.a.id));
    const draw::vec2 on_b = testing::centre(testing::rect_of(frame, buttons.b.id));

    run.step(testing::press(on_a), [&] { declare(frame, buttons); });
    run.step(testing::hold(on_b), [&] { declare(frame, buttons); });
    CHECK(buttons.a.is_pressed);
    CHECK_FALSE(buttons.b.is_hovered);
    run.step(testing::release(on_b), [&] { declare(frame, buttons); });
    CHECK_FALSE(buttons.a.is_activated);
    CHECK_FALSE(buttons.b.is_activated);
}

TEST_CASE("tab moves focus in declaration order and wraps, shift tab moves it back") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    const input_snapshot tab = testing::keys({testing::pressed(key_code::tab)});
    run.step([&] { declare(frame, buttons); });
    CHECK_FALSE(frame.focused().has_value());

    run.step(tab, [&] { declare(frame, buttons); });
    CHECK(frame.focused() == buttons.a.id);
    CHECK(buttons.a.is_focused);
    run.step(tab, [&] { declare(frame, buttons); });
    CHECK(frame.focused() == buttons.b.id);
    run.step(tab, [&] { declare(frame, buttons); });
    run.step(tab, [&] { declare(frame, buttons); });
    CHECK(frame.focused() == buttons.a.id);
    run.step(with_shift(tab), [&] { declare(frame, buttons); });
    CHECK(frame.focused() == buttons.c.id);
}

TEST_CASE("enter and space activate the focused element only") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });
    run.step(testing::keys({testing::pressed(key_code::tab)}), [&] { declare(frame, buttons); });

    run.step(testing::keys({testing::pressed(key_code::enter)}), [&] { declare(frame, buttons); });
    CHECK(buttons.a.is_activated);
    CHECK_FALSE(buttons.b.is_activated);
    run.step(testing::keys({testing::pressed(key_code::space)}), [&] { declare(frame, buttons); });
    CHECK(buttons.a.is_activated);
    run.step(testing::keys({{.code = key_code::enter, .action = key_action::repeated}}), [&] {
        declare(frame, buttons);
    });
    CHECK_FALSE(buttons.a.is_activated);
}

TEST_CASE("pressing an element focuses it, and pressing nothing focusable drops focus") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });

    run.step(testing::press(testing::centre(testing::rect_of(frame, buttons.b.id))), [&] {
        declare(frame, buttons);
    });
    CHECK(frame.focused() == buttons.b.id);
    run.step(testing::release(outside), [&] { declare(frame, buttons); });
    run.step(testing::press(outside), [&] { declare(frame, buttons); });
    CHECK_FALSE(frame.focused().has_value());
}

TEST_CASE("the UI wants the mouse over a root and the keyboard while something has focus") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });

    const draw::vec2 on_c = testing::centre(testing::rect_of(frame, buttons.c.id));
    run.step(testing::hover(on_c), [&] { declare(frame, buttons); });
    CHECK(run.report().wants_mouse);
    CHECK_FALSE(run.report().wants_keyboard);
    run.step(testing::hover(outside), [&] { declare(frame, buttons); });
    CHECK_FALSE(run.report().wants_mouse);
    run.step(testing::keys({testing::pressed(key_code::tab)}), [&] { declare(frame, buttons); });
    CHECK(run.report().wants_keyboard);
}

TEST_CASE("an id's state outlives a frame or two undeclared, then is forgotten") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    const element_id faded = root_id(key<"faded">());
    f32 value = 0.0F;
    run.step([&] { value = frame.approach(faded, 0.0F); });
    run.step([&] { value = frame.approach(faded, 1.0F); });
    CHECK(value > 0.0F);
    CHECK(value < 1.0F);

    run.step([] {});
    run.step([] {});
    run.step([&] { value = frame.approach(faded, 1.0F); });
    CHECK(value < 1.0F);

    for (isize tick = 0; tick < 5; ++tick) {
        run.step([] {});
    }
    run.step([&] { value = frame.approach(faded, 1.0F); });
    CHECK(value == 1.0F);
}

TEST_CASE("a press on an element in its first frame reaches it the frame after") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });
    const draw::vec2 on_b = testing::centre(testing::rect_of(frame, buttons.b.id));

    testing::driver fresh{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& opened = fresh.ui();
    fresh.step(testing::press(on_b), [&] { declare(opened, buttons); });
    CHECK(opened.focused() == buttons.b.id);
    fresh.step(testing::hold(on_b), [&] { declare(opened, buttons); });
    CHECK(buttons.b.is_just_pressed);
    CHECK(buttons.b.is_pressed);
    fresh.step(testing::release(on_b), [&] { declare(opened, buttons); });
    CHECK(buttons.b.is_activated);
}

TEST_CASE("a click begun and ended in an element's first frame clicks it the frame after") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    three_buttons buttons;
    run.step([&] { declare(frame, buttons); });
    const draw::vec2 on_c = testing::centre(testing::rect_of(frame, buttons.c.id));

    testing::driver fresh{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& opened = fresh.ui();
    input_snapshot click = testing::press(on_c);
    click.left = {.is_down = false, .click_count = 1, .is_released = true};
    fresh.step(click, [&] { declare(opened, buttons); });
    fresh.step(testing::hover(on_c), [&] { declare(opened, buttons); });
    CHECK(buttons.c.is_activated);
    fresh.step(testing::hover(on_c), [&] { declare(opened, buttons); });
    CHECK_FALSE(buttons.c.is_activated);
}

}
}
