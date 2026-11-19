#include <array>
#include <optional>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/rect.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/text_spec.hpp>

#include "fixture.hpp"
#include "lucent/draw/color.hpp"

namespace lucent::ui {
namespace {

auto rect_at(f32 left, f32 top, f32 right, f32 bottom) -> std::array<f32, 4> {
    return {left, top, right, bottom};
}

auto box_of(size_rule width, size_rule height) -> box_style {
    return {
        .flow = direction::row,
        .width = width,
        .height = height,
        .gap = 0.0F,
        .main = main_align::start,
        .cross = cross_align::start,
    };
}

auto window_of(const box_style& style) -> window_spec {
    return {.key = key<"window">(), .position = {.x = 10.0F, .y = 20.0F}, .style = style};
}

auto body(text::face_id face, std::string_view utf8) -> text_spec {
    return {
        .utf8 = utf8,
        .style = {.face = face, .size = 16.0F},
        .ink = draw::white,
        .wrap = text::text_wrap::words,
        .overflow = text::text_overflow::visible,
        .max_lines = std::nullopt,
    };
}

auto in_window(local_key key) -> element_id {
    return child_id(root_id(ui::key<"window">()), key);
}

constexpr std::string_view paragraph =
    "Layout runs after declaration, so text wraps at the width its parent finally gives it.";

TEST_CASE("a row hands its leftover room to grow children by weight") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    box_style row = box_of(fixed(410.0F), fixed(50.0F));
    row.padding = even(10.0F);
    row.gap = 10.0F;
    run.step([&] {
        frame.window(window_of(row), [&] {
            frame.box(key<"rigid">(), box_of(fixed(100.0F), grow()), [] {});
            frame.box(key<"single">(), box_of(grow(), grow()), [] {});
            frame.box(key<"twice">(), box_of({.kind = size_kind::grow, .value = 2.0F}, grow()), [] {
            });
        });
    });

    CHECK(
        testing::edges(frame.rect(in_window(key<"rigid">())))
        == rect_at(20.0F, 30.0F, 120.0F, 60.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"single">())))
        == rect_at(130.0F, 30.0F, 220.0F, 60.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"twice">())))
        == rect_at(230.0F, 30.0F, 410.0F, 60.0F)
    );
}

TEST_CASE("a fit column wraps its children, padding and gaps") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    box_style column = box_of(fit(), fit());
    column.flow = direction::column;
    column.padding = {.left = 1.0F, .top = 2.0F, .right = 3.0F, .bottom = 4.0F};
    column.gap = 5.0F;
    run.step([&] {
        frame.window(window_of(column), [&] {
            frame.box(box_of(fixed(30.0F), fixed(10.0F)), [] {});
            frame.box(key<"second">(), box_of(fixed(50.0F), fixed(20.0F)), [] {});
        });
    });

    CHECK(
        testing::edges(frame.rect(root_id(key<"window">()))) == rect_at(10.0F, 20.0F, 64.0F, 61.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"second">())))
        == rect_at(11.0F, 37.0F, 61.0F, 57.0F)
    );
}

TEST_CASE("main and cross alignment share out the room left over") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    box_style row = box_of(fixed(200.0F), fixed(100.0F));
    run.step([&] {
        row.main = main_align::center;
        row.cross = cross_align::end;
        frame.window(window_of(row), [&] {
            frame.box(key<"first">(), box_of(fixed(40.0F), fixed(20.0F)), [] {});
            frame.box(key<"last">(), box_of(fixed(60.0F), fixed(40.0F)), [] {});
        });
    });
    CHECK(
        testing::edges(frame.rect(in_window(key<"first">())))
        == rect_at(60.0F, 100.0F, 100.0F, 120.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"last">())))
        == rect_at(100.0F, 80.0F, 160.0F, 120.0F)
    );

    run.step([&] {
        row.main = main_align::space_between;
        row.cross = cross_align::stretch;
        frame.window(window_of(row), [&] {
            frame.box(key<"first">(), box_of(fixed(40.0F), fit()), [] {});
            frame.box(key<"last">(), box_of(fixed(60.0F), fit()), [] {});
        });
    });
    CHECK(
        testing::edges(frame.rect(in_window(key<"first">())))
        == rect_at(10.0F, 20.0F, 50.0F, 120.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"last">())))
        == rect_at(150.0F, 20.0F, 210.0F, 120.0F)
    );
}

TEST_CASE("a percent child takes its share of the inner size, clamped by min and max") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    box_style column = box_of(fixed(300.0F), fixed(100.0F));
    column.flow = direction::column;
    column.padding = even(50.0F);
    run.step([&] {
        frame.window(window_of(column), [&] {
            frame.box(key<"half">(), box_of(percent(0.5F), fixed(1.0F)), [] {});
            frame.box(
                key<"capped">(),
                box_of(bounded(percent(0.9F), {.min = 0.0F, .max = 120.0F}), fixed(1.0F)),
                [] {}
            );
        });
    });

    CHECK(
        testing::edges(frame.rect(in_window(key<"half">()))) == rect_at(60.0F, 70.0F, 160.0F, 71.0F)
    );
    CHECK(
        testing::edges(frame.rect(in_window(key<"capped">())))
        == rect_at(60.0F, 71.0F, 180.0F, 72.0F)
    );
}

TEST_CASE("wrapping text takes its parent's final width and grows taller") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    box_style wide = box_of(fixed(2000.0F), fit());
    box_style narrow = box_of(fixed(160.0F), fit());
    narrow.padding = even(10.0F);
    run.step([&] {
        frame.window(window_of(wide), [&] {
            frame.text(key<"unwrapped">(), body(fixture.plex, paragraph));
        });
        frame.window(
            {.key = key<"narrow">(), .position = {.x = 0.0F, .y = 300.0F}, .style = narrow},
            [&] { frame.text(key<"wrapped">(), body(fixture.plex, paragraph)); }
        );
    });

    const draw::rect line = testing::rect_of(frame, in_window(key<"unwrapped">()));
    const draw::rect block =
        testing::rect_of(frame, child_id(root_id(key<"narrow">()), key<"wrapped">()));
    CHECK(line.max.x - line.min.x > 140.0F);
    CHECK(block.min.x == 10.0F);
    CHECK(block.max.x == 150.0F);
    CHECK(block.max.y - block.min.y >= 3.0F * (line.max.y - line.min.y));
    CHECK(testing::rect_of(frame, root_id(key<"narrow">())).max.y - block.max.y == 10.0F);
}

TEST_CASE("text with an ellipsis shrinks to its parent while rigid siblings keep their size") {
    testing::fixture_text fixture = testing::plex_text();
    testing::driver run{
        fixture.text, testing::test_theme(fixture.plex, testing::motion_preference::full)
    };
    context& frame = run.ui();
    text_spec spec = body(fixture.plex, paragraph);
    spec.wrap = text::text_wrap::none;
    spec.overflow = text::text_overflow::ellipsis;
    run.step([&] {
        frame.window(window_of(box_of(fixed(200.0F), fit())), [&] {
            frame.text(key<"cut">(), spec);
            frame.box(key<"rigid">(), box_of(fixed(50.0F), fixed(10.0F)), [] {});
        });
    });

    CHECK(testing::rect_of(frame, in_window(key<"cut">())).max.x == 160.0F);
    CHECK(
        testing::edges(frame.rect(in_window(key<"rigid">())))
        == rect_at(160.0F, 20.0F, 210.0F, 30.0F)
    );
}

}
}
