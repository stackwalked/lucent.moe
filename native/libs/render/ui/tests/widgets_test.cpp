#include <array>
#include <optional>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/dropdown.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/label.hpp>
#include <lucent/ui/slider.hpp>
#include <lucent/ui/toggle.hpp>

#include "fixture.hpp"

namespace lucent::ui {
namespace {

constexpr element_id window = root_id(key<"window">());
constexpr element_id volume = child_id(window, key<"volume">());
constexpr element_id track = child_id(volume, key<"track">());
constexpr element_id quality = child_id(window, key<"quality">());
constexpr std::array<std::string_view, 3> levels{"Low", "Medium", "High"};

// A settings page's worth of controls, with the values they edit.
struct page {
    bool is_enabled = false;
    f32 level = 0.0F;
    isize preset = 0;
    std::optional<bool> flipped;
    std::optional<f32> moved;
    std::optional<isize> chosen;
};

auto declare(context& frame, page& settings) -> void {
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
            label(frame, "Audio");
            settings.flipped = toggle(
                frame, key<"enabled">(), {.caption = "Enabled", .is_on = settings.is_enabled}
            );
            settings.moved = slider(
                frame,
                key<"volume">(),
                {
                    .caption = "Volume",
                    .value = settings.level,
                    .min = 0.0F,
                    .max = 10.0F,
                    .step = 1.0F,
                }
            );
            settings.chosen =
                dropdown(frame, key<"quality">(), {.options = levels, .selected = settings.preset});
        }
    );
    if (settings.flipped) {
        settings.is_enabled = *settings.flipped;
    }
    if (settings.moved) {
        settings.level = *settings.moved;
    }
    if (settings.chosen) {
        settings.preset = *settings.chosen;
    }
}

auto click(testing::driver& run, draw::vec2 where, page& settings) -> void {
    context& frame = run.ui();
    run.step(testing::press(where), [&] { declare(frame, settings); });
    run.step(testing::release(where), [&] { declare(frame, settings); });
}

auto key_frame(testing::driver& run, key_code code, page& settings) -> void {
    context& frame = run.ui();
    run.step(testing::keys({testing::pressed(code)}), [&] { declare(frame, settings); });
}

TEST_CASE(
    "a toggle flips on a click anywhere on its row, or space once focused, reporting each change "
    "once"
) {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    page settings;
    run.step([&] { declare(frame, settings); });
    const draw::rect row = testing::rect_of(frame, child_id(window, key<"enabled">()));

    run.step(testing::press({.x = row.min.x + 5.0F, .y = row.min.y + 5.0F}), [&] {
        declare(frame, settings);
    });
    CHECK_FALSE(settings.flipped.has_value());
    run.step(testing::release({.x = row.min.x + 5.0F, .y = row.min.y + 5.0F}), [&] {
        declare(frame, settings);
    });
    CHECK(settings.flipped == true);
    run.step([&] { declare(frame, settings); });
    CHECK_FALSE(settings.flipped.has_value());
    CHECK(settings.is_enabled);

    key_frame(run, key_code::space, settings);
    CHECK(settings.flipped == false);
    CHECK_FALSE(settings.is_enabled);
}

TEST_CASE("dragging a slider's track sets its value stepped, wherever the cursor goes") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    page settings;
    run.step([&] { declare(frame, settings); });
    const draw::rect area = testing::rect_of(frame, track);
    const f32 inset = frame.tokens().controls.thumb_radius;
    const f32 y = (area.min.y + area.max.y) / 2.0F;
    const f32 seventh = area.min.x + inset + ((area.max.x - area.min.x - (2.0F * inset)) * 0.68F);

    run.step(testing::press({.x = seventh, .y = y}), [&] { declare(frame, settings); });
    CHECK(settings.level == 7.0F);
    run.step(testing::hold({.x = 2000.0F, .y = 0.0F}), [&] { declare(frame, settings); });
    CHECK(settings.level == 10.0F);
    run.step(testing::release({.x = -50.0F, .y = y}), [&] { declare(frame, settings); });
    CHECK(settings.level == 0.0F);
    run.step(testing::hover({.x = seventh, .y = y}), [&] { declare(frame, settings); });
    CHECK_FALSE(settings.moved.has_value());
}

TEST_CASE("a focused slider steps with the arrows and jumps with home and end") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    page settings;
    run.step([&] { declare(frame, settings); });
    key_frame(run, key_code::tab, settings);
    key_frame(run, key_code::tab, settings);
    REQUIRE(frame.focused() == track);

    key_frame(run, key_code::right, settings);
    CHECK(settings.level == 1.0F);
    key_frame(run, key_code::end, settings);
    CHECK(settings.level == 10.0F);
    key_frame(run, key_code::left, settings);
    CHECK(settings.level == 9.0F);
    key_frame(run, key_code::home, settings);
    CHECK(settings.level == 0.0F);
}

TEST_CASE("slider values land on whole steps inside the range") {
    const slider_spec quarters{
        .caption = "",
        .value = 0.0F,
        .min = 1.0F,
        .max = 2.0F,
        .step = 0.25F,
    };
    CHECK(slider_value(quarters, 0.3F) == 1.25F);
    CHECK(slider_value(quarters, 0.4F) == 1.5F);
    CHECK(slider_value(quarters, -1.0F) == 1.0F);
    CHECK(slider_value(quarters, 7.0F) == 2.0F);
}

TEST_CASE("a dropdown opens on a press, and choosing an option closes it with the new index") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    page settings;
    run.step([&] { declare(frame, settings); });
    const draw::vec2 field = testing::centre(testing::rect_of(frame, quality));

    run.step(testing::press(field), [&] { declare(frame, settings); });
    CHECK(frame.is_popup_open(quality));
    run.step(testing::release(field), [&] { declare(frame, settings); });
    REQUIRE(frame.is_popup_open(quality));

    const draw::rect high = testing::rect_of(frame, child_id(popup_id(quality), key_from_index(2)));
    CHECK(high.min.y > testing::rect_of(frame, quality).max.y);
    click(run, testing::centre(high), settings);
    CHECK(settings.chosen == 2);
    CHECK_FALSE(frame.is_popup_open(quality));
}

TEST_CASE("a press on an open dropdown's field closes it") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    page settings;
    run.step([&] { declare(frame, settings); });
    const draw::vec2 field = testing::centre(testing::rect_of(frame, quality));

    click(run, field, settings);
    CHECK(frame.is_popup_open(quality));
    click(run, field, settings);
    CHECK_FALSE(frame.is_popup_open(quality));
    CHECK_FALSE(settings.chosen.has_value());
}

auto focus_quality(testing::driver& run, page& settings) -> void {
    context& frame = run.ui();
    run.step([&] { declare(frame, settings); });
    for (isize press = 0; press < 3; ++press) {
        key_frame(run, key_code::tab, settings);
    }
}

TEST_CASE("a closed, focused dropdown steps its selection with up and down") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    page settings;
    focus_quality(run, settings);
    REQUIRE(run.ui().focused() == quality);

    key_frame(run, key_code::down, settings);
    key_frame(run, key_code::down, settings);
    key_frame(run, key_code::down, settings);
    CHECK(settings.preset == 2);
    key_frame(run, key_code::up, settings);
    CHECK(settings.preset == 1);
}

TEST_CASE("enter opens a focused dropdown on its selection; the arrows and enter choose") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    const context& frame = run.ui();
    page settings;
    settings.preset = 1;
    focus_quality(run, settings);

    key_frame(run, key_code::enter, settings);
    REQUIRE(frame.is_popup_open(quality));
    CHECK(frame.focused() == child_id(popup_id(quality), key_from_index(1)));
    key_frame(run, key_code::down, settings);
    key_frame(run, key_code::enter, settings);
    CHECK(settings.chosen == 2);
    CHECK_FALSE(frame.is_popup_open(quality));
    CHECK(frame.focused() == quality);
}

}
}
