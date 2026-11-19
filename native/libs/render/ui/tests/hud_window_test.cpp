#include <lucent/ui/hud_window.hpp>

#include <array>
#include <utility>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/label.hpp>

#include "fixture.hpp"
#include "lucent/ui/input_snapshot.hpp"

namespace lucent::ui {
namespace {

constexpr element_id spectators = root_id(key<"spectators">());

struct hud_run {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    hud_placements placements;
    hud_mode mode = hud_mode::arranging;

    auto step(input_snapshot input) -> void {
        context& frame = run.ui();
        run.step(std::move(input), [&] {
            hud_window(
                frame,
                placements,
                {
                    .key = key<"spectators">(),
                    .title = "Spectators",
                    .position = {.x = 100.0F, .y = 100.0F},
                    .width = fixed(160.0F),
                    .mode = mode,
                },
                [&] { label(frame, "nobody"); }
            );
        });
    }

    auto title() -> draw::vec2 {
        return testing::centre(testing::rect_of(run.ui(), hud_title_id(spectators)));
    }
};

auto corner_of(hud_run& hud) -> std::array<f32, 2> {
    const draw::rect placed = testing::rect_of(hud.run.ui(), spectators);
    return {placed.min.x, placed.min.y};
}

TEST_CASE("while arranging, the title bar drags the window and its place is kept") {
    hud_run hud;
    hud.step({});
    const draw::vec2 grip = hud.title();

    hud.step(testing::press(grip));
    hud.step(testing::hold(grip + draw::vec2{.x = 50.0F, .y = 20.0F}));
    hud.step(testing::release(grip + draw::vec2{.x = 50.0F, .y = 20.0F}));
    CHECK(corner_of(hud) == std::array{150.0F, 120.0F});
    const draw::vec2 kept = hud.placements.positions.at(key<"spectators">());
    CHECK(std::array{kept.x, kept.y} == std::array{150.0F, 120.0F});

    hud.mode = hud_mode::locked;
    hud.step({});
    CHECK(corner_of(hud) == std::array{150.0F, 120.0F});
}

TEST_CASE("a dragged window stays inside the viewport") {
    hud_run hud;
    hud.step({});
    const draw::vec2 grip = hud.title();
    hud.step(testing::press(grip));
    hud.step(testing::hold({.x = -500.0F, .y = 5000.0F}));
    const draw::rect placed = testing::rect_of(hud.run.ui(), spectators);
    CHECK(std::array{placed.min.x, placed.max.y} == std::array{0.0F, testing::viewport.y});
}

TEST_CASE("a locked window lets input through and never moves") {
    hud_run hud;
    hud.mode = hud_mode::locked;
    hud.step({});
    const draw::vec2 grip = hud.title();
    hud.step(testing::press(grip));
    CHECK_FALSE(hud.run.report().wants_mouse);
    hud.step(testing::hold(grip + draw::vec2{.x = 50.0F, .y = 0.0F}));
    CHECK(corner_of(hud) == std::array{100.0F, 100.0F});
    CHECK(hud.placements.positions.empty());
}

}
}
