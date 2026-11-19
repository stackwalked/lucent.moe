#include <lucent/ui/color_picker.hpp>

#include <optional>
#include <utility>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/flags.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>

#include "fixture.hpp"
#include "lucent/draw/vec2.hpp"

namespace lucent::ui {
namespace {

constexpr element_id swatch = child_id(root_id(key<"window">()), key<"tint">());

auto part(local_key key) -> element_id {
    return child_id(popup_id(swatch), key);
}

TEST_CASE("colours survive the trip through hue, saturation and value") {
    for (const draw::color tint : {
             draw::color{.r = 200, .g = 40, .b = 40, .a = 255},
             draw::color{.r = 12, .g = 180, .b = 90, .a = 10},
             draw::color{.r = 80, .g = 80, .b = 80, .a = 128},
             draw::color{.r = 255, .g = 0, .b = 255, .a = 0},
         }) {
        CHECK(from_hsv(to_hsv(tint), tint.a) == tint);
    }
}

TEST_CASE("hex codes read with or without the hash and alpha, and anything else is refused") {
    CHECK(from_hex("#ff8000") == draw::color{.r = 255, .g = 128, .b = 0, .a = 255});
    CHECK(from_hex("FF800040") == draw::color{.r = 255, .g = 128, .b = 0, .a = 64});
    CHECK_FALSE(from_hex("#ff80").has_value());
    CHECK_FALSE(from_hex("#ff80zz").has_value());
    CHECK(hex_of({.r = 255, .g = 128, .b = 0, .a = 64}) == "#ff800040");
}

auto with_all_selected() -> input_snapshot {
    input_snapshot input = testing::keys({testing::pressed(key_code::letter_a)});
    input.modifiers = flags{modifier::control};
    return input;
}

struct picker_run {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::reduced)
    };
    draw::color value{.r = 128, .g = 128, .b = 128, .a = 255};
    std::optional<draw::color> picked;

    auto step(input_snapshot input) -> void {
        context& frame = run.ui();
        run.step(std::move(input), [&] {
            frame.window(
                {
                    .key = key<"window">(),
                    .position = {.x = 10.0F, .y = 10.0F},
                    .style =
                        {
                            .flow = direction::column,
                            .width = fixed(300.0F),
                            .height = fit(),
                            .gap = 0.0F,
                            .main = main_align::start,
                            .cross = cross_align::start,
                        },
                },
                [&] { picked = color_picker(frame, key<"tint">(), value); }
            );
        });
        if (picked) {
            value = *picked;
        }
    }

    auto open() -> void {
        step({});
        const draw::vec2 on_swatch = testing::centre(testing::rect_of(run.ui(), swatch));
        step(testing::press(on_swatch));
        step(testing::release(on_swatch));
        step({});
    }
};

TEST_CASE("the square sets saturation and value, and a grey keeps the hue last picked") {
    picker_run picker;
    picker.open();
    REQUIRE(picker.run.ui().is_popup_open(swatch));
    const draw::rect hue = testing::rect_of(picker.run.ui(), part(key<"hue">()));
    // A third along the hue bar is green.
    const draw::vec2 green{
        .x = hue.min.x + ((hue.max.x - hue.min.x) / 3.0F),
        .y = hue.min.y + 1.0F,
    };
    picker.step(testing::press(green));
    picker.step(testing::release(green));
    const draw::rect square = testing::rect_of(picker.run.ui(), part(key<"square">()));
    picker.step(testing::press(testing::centre(square)));
    picker.step(testing::hold({.x = square.max.x + 10.0F, .y = square.min.y - 10.0F}));
    CHECK(picker.value == draw::color{.r = 0, .g = 255, .b = 0, .a = 255});
}

TEST_CASE("a hex code typed into the picker's field sets the colour once it is whole") {
    picker_run picker;
    picker.open();
    const draw::vec2 on_field =
        testing::centre(testing::rect_of(picker.run.ui(), part(key<"hex">())));
    picker.step(testing::press(on_field));
    picker.step(testing::release(on_field));
    picker.step(with_all_selected());
    picker.step(testing::typed("#3366"));
    CHECK(picker.value == draw::color{.r = 128, .g = 128, .b = 128, .a = 255});
    picker.step(testing::typed("99"));
    CHECK(picker.value == draw::color{.r = 0x33, .g = 0x66, .b = 0x99, .a = 255});
}

}
}
