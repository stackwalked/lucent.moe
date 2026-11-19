#include <lucent/ui/text_field.hpp>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>

#include "fixture.hpp"

namespace lucent::ui {
namespace {

constexpr element_id field = child_id(root_id(key<"window">()), key<"field">());

// A field in a window, holding its text between frames as an owner would.
struct form {
    std::string text;
    text_lines lines = text_lines::single;
    text_field_outcome last;
};

auto declare(context& frame, form& owner) -> void {
    frame.window(
        {
            .key = key<"window">(),
            .position = {.x = 0.0F, .y = 0.0F},
            .style =
                {
                    .flow = direction::column,
                    .width = fixed(300.0F),
                    .height = fit(),
                    .gap = 0.0F,
                    .main = main_align::start,
                    .cross = cross_align::stretch,
                },
        },
        [&] {
            owner.last = text_field(
                frame,
                key<"field">(),
                {.utf8 = owner.text, .hint = "Type here", .lines = owner.lines, .visible_lines = 3}
            );
        }
    );
    if (owner.last.edited) {
        owner.text = *owner.last.edited;
    }
}

// A run with the field declared once and focused by a click at its start.
struct field_run {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    testing::memory_clipboard shared;
    form owner;

    auto step(input_snapshot input) -> void {
        context& frame = run.ui();
        run.step(std::move(input), [&] { declare(frame, owner); });
    }

    auto click(draw::vec2 where) -> void {
        step(testing::press(where));
        step(testing::release(where));
    }

    auto focus() -> void {
        run.lend(shared);
        step({});
        click(start());
    }

    auto area() -> draw::rect {
        return testing::rect_of(run.ui(), field);
    }

    auto start() -> draw::vec2 {
        return {.x = area().min.x + 1.0F, .y = testing::centre(area()).y};
    }

    auto end() -> draw::vec2 {
        return {.x = area().max.x - 2.0F, .y = testing::centre(area()).y};
    }
};

auto with(input_snapshot input, flags<modifier> held) -> input_snapshot {
    input.modifiers = held;
    return input;
}

auto ordered(std::vector<keyboard_event> events) -> input_snapshot {
    input_snapshot input;
    input.keyboard = std::move(events);
    return input;
}

auto control(key_code code) -> input_snapshot {
    return with(testing::keys({testing::pressed(code)}), flags{modifier::control});
}

TEST_CASE("typing and erasing apply in the order they happened within a frame") {
    field_run field_test;
    field_test.focus();
    REQUIRE(field_test.run.ui().focused() == field);

    field_test.step(ordered({
        typed_text{.utf8 = "abc"},
        testing::pressed(key_code::backspace),
        typed_text{.utf8 = "d"},
    }));
    CHECK(field_test.owner.text == "abd");
}

TEST_CASE("a field without focus ignores typing") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    form owner;
    context& frame = run.ui();
    run.step(testing::typed("x"), [&] { declare(frame, owner); });
    run.step(testing::typed("x"), [&] { declare(frame, owner); });
    CHECK(owner.text.empty());
}

TEST_CASE("a press places the caret where it lands, before or after the glyph's middle") {
    field_run field_test;
    field_test.owner.text = "word";
    field_test.focus();
    field_test.step(testing::typed("X"));
    CHECK(field_test.owner.text == "Xword");

    field_test.click(field_test.end());
    field_test.step(testing::typed("Y"));
    CHECK(field_test.owner.text == "XwordY");
}

TEST_CASE("select all, copy and paste go through the frame's clipboard") {
    field_run field_test;
    field_test.owner.text = "copied";
    field_test.focus();

    field_test.step(control(key_code::letter_a));
    field_test.step(control(key_code::letter_c));
    CHECK(field_test.shared.text() == "copied");
    field_test.step(control(key_code::letter_x));
    CHECK(field_test.owner.text.empty());
    field_test.step(control(key_code::letter_v));
    field_test.step(control(key_code::letter_v));
    CHECK(field_test.owner.text == "copiedcopied");
}

TEST_CASE("a paste into a single line turns line breaks into spaces") {
    field_run field_test;
    field_test.focus();
    field_test.shared.put_text("one\ntwo");
    field_test.step(control(key_code::letter_v));
    CHECK(field_test.owner.text == "one two");
}

TEST_CASE("control z undoes and control y redoes") {
    field_run field_test;
    field_test.focus();
    field_test.step(testing::typed("draft"));
    field_test.step(control(key_code::letter_z));
    CHECK(field_test.owner.text.empty());
    field_test.step(control(key_code::letter_y));
    CHECK(field_test.owner.text == "draft");
}

TEST_CASE("a double click selects the word under it, which typing then replaces") {
    field_run field_test;
    field_test.owner.text = "alpha beta";
    field_test.focus();
    const draw::vec2 where = field_test.start();
    input_snapshot second = testing::press(where);
    second.left.click_count = 2;
    field_test.step(second);
    field_test.step(testing::release(where));
    field_test.step(testing::typed("gamma"));
    CHECK(field_test.owner.text == "gamma beta");
}

TEST_CASE("dragging across the text selects it") {
    field_run field_test;
    field_test.owner.text = "dragged";
    field_test.focus();
    field_test.step(testing::press(field_test.start()));
    field_test.step(testing::hold(field_test.end()));
    field_test.step(testing::release(field_test.end()));
    field_test.step(testing::typed("z"));
    CHECK(field_test.owner.text == "z");
}

TEST_CASE("a composition shows in the field but stays out of its text until committed") {
    field_run field_test;
    field_test.focus();
    field_test.step(ordered({composition{.utf8 = "ni", .caret = 2}}));
    CHECK(field_test.owner.text.empty());
    CHECK_FALSE(field_test.owner.last.edited.has_value());
    field_test.step(
        ordered({composition{.utf8 = {}, .caret = 0}, typed_text{.utf8 = "\xE4\xBD\xA0"}})
    );
    CHECK(field_test.owner.text == "\xE4\xBD\xA0");
}

TEST_CASE("enter submits a single line and breaks a multi-line field's line") {
    field_run single;
    single.focus();
    single.step(testing::keys({testing::pressed(key_code::enter)}));
    CHECK(single.owner.last.is_submitted);
    CHECK(single.owner.text.empty());

    field_run multiple;
    multiple.owner.lines = text_lines::multiple;
    multiple.focus();
    multiple.step(ordered(
        {typed_text{.utf8 = "a"}, testing::pressed(key_code::enter), typed_text{.utf8 = "b"}}
    ));
    CHECK(multiple.owner.text == "a\nb");
    CHECK_FALSE(multiple.owner.last.is_submitted);
}

TEST_CASE("up and down in a multi-line field keep to the caret's column") {
    field_run field_test;
    field_test.owner.lines = text_lines::multiple;
    field_test.owner.text = "abc\nabc";
    field_test.focus();
    field_test.click({.x = field_test.start().x, .y = field_test.area().min.y + 6.0F});
    field_test.step(testing::keys({testing::pressed(key_code::right)}));
    field_test.step(testing::keys({testing::pressed(key_code::down)}));
    field_test.step(testing::typed("X"));
    CHECK(field_test.owner.text == "abc\naXbc");
}

TEST_CASE("text changed by its owner replaces the field's") {
    field_run field_test;
    field_test.focus();
    field_test.step(testing::typed("mine"));
    field_test.owner.text = "theirs";
    field_test.step({});
    field_test.step(testing::typed("!"));
    CHECK(field_test.owner.text == "theirs!");
}

}
}
