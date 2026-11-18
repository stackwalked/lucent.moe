#include <lucent/draw/draw_list.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <numbers>
#include <ranges>
#include <string>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/arc.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/half.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/quad_record.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/segment.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/testing/invariant_violation.hpp>

namespace lucent::draw {
namespace {

constexpr color red{.r = 255, .g = 0, .b = 0, .a = 255};
constexpr pixel_size target{.width = 800, .height = 600};

auto box(f32 left, f32 top, f32 right, f32 bottom) -> rect {
    return {.min = {.x = left, .y = top}, .max = {.x = right, .y = bottom}};
}

auto list_at(f32 pixels_per_unit) -> draw_list {
    draw_list list;
    list.reset({.size = target, .pixels_per_unit = pixels_per_unit});
    return list;
}

auto stroke_of(const quad_record& record) -> f32 {
    return from_half(narrow<u16>(record.style[3] >> 16U));
}

auto is_whole(f32 value) -> bool {
    return std::abs(value - std::round(value)) < 1.0e-4F;
}

auto quad_runs(const frame_data& frame) -> std::vector<quad_run> {
    std::vector<quad_run> runs;
    for (const command& next : frame.commands) {
        match(
            next,
            [&runs](const quad_run& run) { runs.push_back(run); },
            [](const path_run&) {},
            [](const layer_begin&) {},
            [](const layer_end&) {}
        );
    }
    return runs;
}

// The kinds of the commands in order: 'q' quad run, 'p' path run, '(' and ')' a layer.
auto shape_of(const frame_data& frame) -> std::string {
    std::string kinds;
    for (const command& next : frame.commands) {
        kinds += match(
            next,
            [](const quad_run&) { return 'q'; },
            [](const path_run&) { return 'p'; },
            [](const layer_begin&) { return '('; },
            [](const layer_end&) { return ')'; }
        );
    }
    return kinds;
}

}

TEST_CASE("rect edges land on whole pixels at a fractional scale") {
    draw_list list = list_at(1.5F);
    list.push_translation({.x = 0.3F, .y = 0.7F});
    list.fill(rounded_rect{.bounds = box(0.3F, 0.3F, 10.3F, 7.1F), .radii = {}}, solid(red));
    list.pop_translation();
    const quad_record& record = list.frame().records.front();
    CHECK(std::ranges::all_of(record.rect, is_whole));
}

TEST_CASE("a one-unit stroke and a one-unit-thin rect are whole pixels wherever they start") {
    draw_list list = list_at(1.5F);
    for (const f32 start : {0.0F, 0.25F, 0.5F, 0.75F}) {
        list.stroke(
            rounded_rect{.bounds = box(start, start, start + 10.0F, start + 10.0F), .radii = {}},
            solid(red),
            {.width = 1.0F, .ends = cap::butt}
        );
        list.fill(
            rounded_rect{.bounds = box(0.0F, start, 10.0F, start + 1.0F), .radii = {}}, solid(red)
        );
    }
    const frame_data frame = list.frame();
    REQUIRE(frame.records.size() == 8);
    for (const auto [index, record] : std::views::enumerate(frame.records)) {
        if (index % 2 == 0) {
            CHECK(stroke_of(record) == 2.0F);
        } else {
            CHECK(record.rect[3] - record.rect[1] == 2.0F);
        }
    }
}

TEST_CASE("curves keep their exact positions") {
    draw_list list = list_at(1.0F);
    list.fill(circle{.centre = {.x = 10.25F, .y = 20.5F}, .radius = 4.0F}, solid(red));
    const quad_record& record = list.frame().records.front();
    CHECK(record.rect == std::array{6.25F, 16.5F, 14.25F, 24.5F});
}

TEST_CASE("draws under one clip join one run, and a new clip starts another") {
    draw_list list = list_at(1.0F);
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    list.fill(circle{.centre = {.x = 50, .y = 50}, .radius = 5}, solid(red));
    list.push_clip(box(0, 0, 100, 100));
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    list.pop_clip();
    const std::vector<quad_run> runs = quad_runs(list.frame());
    REQUIRE(runs.size() == 2);
    CHECK(runs.at(0).count == 2);
    CHECK(runs.at(1).clip == pixel_rect{.left = 0, .top = 0, .right = 100, .bottom = 100});
}

TEST_CASE("a second image splits a run, but glyphs on other atlas pages do not") {
    draw_list list = list_at(1.0F);
    const std::array glyphs{
        glyph_quad{
            .page = atlas_page{0},
            .bounds = box(0, 0, 8, 8),
            .uv = box(0, 0, 0, 0),
            .tint = red,
        },
        glyph_quad{
            .page = atlas_page{7},
            .bounds = box(8, 0, 16, 8),
            .uv = box(0, 0, 0, 0),
            .tint = red,
        },
    };
    list.draw(glyph_run{.origin = {.x = 10, .y = 10}, .glyphs = glyphs});
    list.draw(image_quad{.image = image_handle{1}, .bounds = box(0, 0, 32, 32)});
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    list.draw(image_quad{.image = image_handle{1}, .bounds = box(40, 0, 72, 32)});
    list.draw(image_quad{.image = image_handle{2}, .bounds = box(80, 0, 112, 32)});
    list.draw(glyph_run{.origin = {.x = 10, .y = 50}, .glyphs = glyphs});
    const std::vector<quad_run> runs = quad_runs(list.frame());
    REQUIRE(runs.size() == 2);
    CHECK(runs.at(0).count == 5);
    CHECK(runs.at(0).image == image_handle{1});
    CHECK(runs.at(1).count == 3);
    CHECK(runs.at(1).image == image_handle{2});
}

TEST_CASE("paths are their own commands and keep draw order") {
    draw_list list = list_at(1.0F);
    const std::array triangle{vec2{.x = 0, .y = 0}, vec2{.x = 20, .y = 0}, vec2{.x = 0, .y = 20}};
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    list.fill_convex(triangle, red);
    list.fill_convex(triangle, red);
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    CHECK(shape_of(list.frame()) == "qpq");
}

TEST_CASE("a shape outside the clip records nothing, but a shadow reaching into it does") {
    draw_list list = list_at(1.0F);
    list.push_clip(box(100, 100, 200, 200));
    list.fill(rounded_rect{.bounds = box(0, 0, 50, 50), .radii = {}}, solid(red));
    list.fill(rounded_rect{.bounds = box(0, 0, 99, 99), .radii = {}}, solid(red));
    list.shadow(
        rounded_rect{.bounds = box(0, 0, 90, 90), .radii = {}},
        {.tint = red, .blur = 4.0F, .spread = 0.0F, .offset = {}}
    );
    list.pop_clip();
    const frame_data frame = list.frame();
    REQUIRE(frame.records.size() == 1);
    CHECK(from_half(narrow<u16>(frame.records.front().style[3] & 0xffffU)) == 4.0F);
}

TEST_CASE("a layer opens under the clip in effect and clips what it holds") {
    draw_list list = list_at(2.0F);
    list.push_clip(box(0, 0, 100, 100));
    list.push_layer({.bounds = box(10, 10, 60, 60), .radius = 4, .opacity = 0.5F, .blur = 3});
    list.fill(rounded_rect{.bounds = box(0, 0, 200, 200), .radii = {}}, solid(red));
    list.pop_layer();
    list.pop_clip();
    const frame_data frame = list.frame();
    CHECK(shape_of(frame) == "(q)");
    const layer_begin begin = match(
        frame.commands.front(),
        [](const quad_run&) { return layer_begin{}; },
        [](const path_run&) { return layer_begin{}; },
        [](const layer_begin& opened) { return opened; },
        [](const layer_end&) { return layer_begin{}; }
    );
    CHECK(begin.clip == pixel_rect{.left = 0, .top = 0, .right = 200, .bottom = 200});
    CHECK(begin.surface.radius == 8.0F);
    CHECK(begin.surface.blur == 6.0F);
    CHECK(
        quad_runs(frame).front().clip
        == pixel_rect{.left = 20, .top = 20, .right = 120, .bottom = 120}
    );
}

TEST_CASE("a frame the list records passes the backend's check") {
    draw_list list = list_at(1.25F);
    const std::array triangle{vec2{.x = 0, .y = 0}, vec2{.x = 20, .y = 0}, vec2{.x = 0, .y = 20}};
    list.push_layer(
        {.bounds = box(0, 0, 300, 300), .radius = 12, .opacity = 1, .blur = 8, .rim = 2}
    );
    list.shadow(
        rounded_rect{.bounds = box(20, 20, 120, 80), .radii = uniform(6)},
        {.tint = red, .blur = 8, .spread = 0, .offset = {}}
    );
    list.fill(rounded_rect{.bounds = box(20, 20, 120, 80), .radii = uniform(6)}, noise(red));
    list.stroke(
        arc{.centre = {.x = 200, .y = 200}, .radius = 30, .start = 0, .sweep = 2}, solid(red), {}
    );
    list.stroke(
        segment{.from = {.x = 0, .y = 0}, .to = {.x = 40, .y = 9}},
        solid(red),
        {.width = 3, .ends = cap::round}
    );
    list.fill_polygon(triangle, red);
    list.draw(image_quad{.image = image_handle{3}, .bounds = box(0, 0, 16, 16)});
    list.pop_layer();
    CHECK(check(list.frame()).has_value());
}

TEST_CASE("exceeding the record limit is an invariant violation") {
    draw_list list = list_at(1.0F);
    for (isize index = 0; index < draw_list::max_records; ++index) {
        list.fill(rounded_rect{.bounds = box(0, 0, 4, 4), .radii = {}}, solid(red));
    }
    CHECK_THROWS_AS(
        list.fill(rounded_rect{.bounds = box(0, 0, 4, 4), .radii = {}}, solid(red)),
        testing::invariant_violation
    );
}

TEST_CASE(
    "popping a layer over an open clip, or taking a frame mid-push, is an invariant violation"
) {
    draw_list list = list_at(1.0F);
    list.push_layer({.bounds = box(0, 0, 10, 10)});
    list.push_clip(box(0, 0, 5, 5));
    CHECK_THROWS_AS(list.pop_layer(), testing::invariant_violation);
    CHECK_THROWS_AS(std::ignore = list.frame(), testing::invariant_violation);
}

TEST_CASE("a level hairline segment covers exactly one row of pixels, and a plumb one one column") {
    draw_list list = list_at(1.0F);
    list.stroke(
        segment{.from = {.x = 0.0F, .y = 10.3F}, .to = {.x = 100.0F, .y = 10.3F}},
        solid(red),
        {.width = 1.0F, .ends = cap::butt}
    );
    list.stroke(
        segment{.from = {.x = 20.6F, .y = 0.0F}, .to = {.x = 20.6F, .y = 50.0F}},
        solid(red),
        {.width = 1.0F, .ends = cap::butt}
    );
    const frame_data frame = list.frame();
    REQUIRE(frame.records.size() == 2);
    const quad_record& level = frame.records.front();
    CHECK(level.rect[1] == 10.0F);
    CHECK(level.rect[3] == 11.0F);
    const quad_record& plumb = frame.records.back();
    CHECK(plumb.rect[0] == 20.0F);
    CHECK(plumb.rect[2] == 21.0F);
}

TEST_CASE("a rect moved by whole pixels keeps its pixel width, across zero too") {
    draw_list list = list_at(1.0F);
    for (const i32 step : std::views::iota(-4, 4)) {
        const f32 left = static_cast<f32>(step) + 0.5F;
        list.fill(rounded_rect{.bounds = box(left, 0, left + 5.0F, 5), .radii = {}}, solid(red));
    }
    for (const quad_record& record : list.frame().records) {
        CHECK(record.rect[2] - record.rect[0] == 5.0F);
    }
}

TEST_CASE("a translation lands on whole pixels when pushed, rounding half up") {
    draw_list list = list_at(1.0F);
    list.push_translation({.x = 0.6F, .y = -0.5F});
    list.fill(rounded_rect{.bounds = box(0, 0, 10, 10), .radii = {}}, solid(red));
    list.pop_translation();
    const quad_record& record = list.frame().records.front();
    CHECK(record.rect == std::array{1.0F, 0.0F, 11.0F, 10.0F});
}

TEST_CASE("an arc records its radius, half band, half sweep and a wrapped mid angle") {
    draw_list list = list_at(1.0F);
    list.stroke(
        arc{.centre = {.x = 100, .y = 100}, .radius = 20, .start = 100.0F, .sweep = 1.0F},
        solid(red),
        {.width = 4.0F, .ends = cap::butt}
    );
    const quad_record& record = list.frame().records.front();
    CHECK(record.rect == std::array{78.0F, 78.0F, 122.0F, 122.0F});
    CHECK(record.geometry[0] == 20.0F);
    CHECK(record.geometry[1] == 2.0F);
    CHECK(record.geometry[2] == 0.5F);
    CHECK(std::abs(record.geometry[3]) <= std::numbers::pi_v<f32>);
    CHECK(
        std::abs(std::remainder(record.geometry[3] - 100.5F, 2.0F * std::numbers::pi_v<f32>))
        < 1.0e-3F
    );
}

TEST_CASE("a butt-capped segment of no length records nothing, a round-capped one a dot") {
    draw_list list = list_at(1.0F);
    const segment point{.from = {.x = 5, .y = 5}, .to = {.x = 5, .y = 5}};
    list.stroke(point, solid(red), {.width = 3.0F, .ends = cap::butt});
    list.stroke(point, solid(red), {.width = 3.0F, .ends = cap::round});
    const frame_data frame = list.frame();
    REQUIRE(frame.records.size() == 1);
    CHECK(unpack_kinds(frame.records.front().style[2]).value_or(record_kinds{}).ends == cap::round);
}

TEST_CASE("strokes, arcs, segments and paths wholly outside the clip record nothing") {
    draw_list list = list_at(1.0F);
    const std::array outside{vec2{.x = 0, .y = 0}, vec2{.x = 20, .y = 0}, vec2{.x = 0, .y = 20}};
    const std::array straddling{
        vec2{.x = 90, .y = 90},
        vec2{.x = 150, .y = 90},
        vec2{.x = 90, .y = 150},
    };
    list.push_clip(box(100, 100, 200, 200));
    list.stroke(rounded_rect{.bounds = box(0, 0, 50, 50), .radii = {}}, solid(red), {});
    list.stroke(
        arc{.centre = {.x = 30, .y = 30}, .radius = 20, .start = 0, .sweep = 3}, solid(red), {}
    );
    list.stroke(segment{.from = {.x = 0, .y = 0}, .to = {.x = 90, .y = 50}}, solid(red), {});
    list.fill_convex(outside, red);
    list.fill_convex(straddling, red);
    list.pop_clip();
    const frame_data frame = list.frame();
    CHECK(frame.records.empty());
    CHECK(shape_of(frame) == "p");
}

TEST_CASE("nesting clips past the limit is an invariant violation") {
    draw_list list = list_at(1.0F);
    for (isize depth = 0; depth < draw_list::max_clip_depth; ++depth) {
        list.push_clip(box(0, 0, 10, 10));
    }
    CHECK_THROWS_AS(list.push_clip(box(0, 0, 10, 10)), testing::invariant_violation);
}

TEST_CASE("nesting layers past the limit is an invariant violation") {
    draw_list list = list_at(1.0F);
    for (isize depth = 0; depth < draw_list::max_layer_depth; ++depth) {
        list.push_layer({.bounds = box(0, 0, 10, 10)});
    }
    CHECK_THROWS_AS(list.push_layer({.bounds = box(0, 0, 10, 10)}), testing::invariant_violation);
}

TEST_CASE("nesting translations past the limit is an invariant violation") {
    draw_list list = list_at(1.0F);
    for (isize depth = 0; depth < draw_list::max_translation_depth; ++depth) {
        list.push_translation({.x = 1, .y = 1});
    }
    CHECK_THROWS_AS(list.push_translation({.x = 1, .y = 1}), testing::invariant_violation);
}

TEST_CASE("popping a layer's own clip is an invariant violation") {
    draw_list list = list_at(1.0F);
    list.push_layer({.bounds = box(0, 0, 10, 10)});
    CHECK_THROWS_AS(list.pop_clip(), testing::invariant_violation);
}

}
