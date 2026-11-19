#include <algorithm>
#include <cstddef>
#include <optional>
#include <string_view>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/quad_record.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>

#include "../src/text_engine.hpp"
#include "fixture.hpp"
#include "lucent/draw/atlas_patch.hpp"

namespace lucent::text {
namespace {

auto request(std::string_view utf8, face_id face) -> layout_request {
    return {
        .utf8 = utf8,
        .style = {.face = face, .size = 16.0F},
        .max_width = 0.0F,
        .wrap = text_wrap::none,
        .overflow = text_overflow::visible,
        .max_lines = std::nullopt,
        .pixels_per_unit = 1.0F,
    };
}

// Atlas records drawn for the text this frame.
auto drawn(text_engine& engine, std::string_view utf8, face_id face) -> isize {
    draw::draw_list list;
    list.reset({.size = {.width = 400, .height = 100}, .pixels_per_unit = 1.0F});
    const result<const text_layout*> made = engine.layout(request(utf8, face));
    LUCENT_INVARIANT(made.has_value());
    LUCENT_INVARIANT(engine.draw(list, **made, {.x = 10.0F, .y = 10.0F}, draw::white).has_value());
    return std::ranges::count_if(list.frame().records, [](const draw::quad_record& record) {
        const std::optional<draw::record_kinds> kinds = draw::unpack_kinds(record.style[2]);
        return kinds && kinds->quad == draw::quad_kind::atlas;
    });
}

TEST_CASE("every inked glyph draws as one atlas quad once rasterized, spaces as none") {
    const testing::fixture_engine fixture = testing::plex_engine();

    CHECK(drawn(*fixture.engine, "ab cd", fixture.plex) == 4);
    const std::vector<draw::atlas_patch> patches = fixture.engine->atlas().take_patches();
    REQUIRE_FALSE(patches.empty());
    CHECK(std::ranges::all_of(patches, [](const draw::atlas_patch& patch) {
        return std::ranges::any_of(patch.coverage, [](std::byte texel) {
            return texel != std::byte{0};
        });
    }));
}

TEST_CASE("glyphs past the frame's raster budget draw in later frames") {
    const testing::fixture_engine fixture = testing::plex_engine({
        .raster_budget = 2,
        .layout_lifetime = 4,
        .atlas = {.page_size = draw::atlas_page_size, .page_count = draw::atlas_page_count},
    });

    CHECK(drawn(*fixture.engine, "abcde", fixture.plex) == 2);
    fixture.engine->begin_frame();
    CHECK(drawn(*fixture.engine, "abcde", fixture.plex) == 4);
    fixture.engine->begin_frame();
    CHECK(drawn(*fixture.engine, "abcde", fixture.plex) == 5);
}

TEST_CASE("prewarmed glyphs draw on their first frame whatever the budget") {
    const testing::fixture_engine fixture = testing::plex_engine({
        .raster_budget = 0,
        .layout_lifetime = 4,
        .atlas = {.page_size = draw::atlas_page_size, .page_count = draw::atlas_page_count},
    });

    REQUIRE(fixture.engine->prewarm(request("abcde", fixture.plex)).has_value());

    CHECK(drawn(*fixture.engine, "abcde", fixture.plex) == 5);
    CHECK(drawn(*fixture.engine, "f", fixture.plex) == 0);
}

TEST_CASE("a glyph whose page was cleared is rasterized again rather than drawn stale") {
    // One page with room for one glyph: a frame's first new glyph clears it, and the rest wait.
    const testing::fixture_engine fixture = testing::plex_engine({
        .raster_budget = 64,
        .layout_lifetime = 4,
        .atlas = {.page_size = 16, .page_count = 1},
    });
    CHECK(drawn(*fixture.engine, "MN", fixture.plex) == 1);
    std::ignore = fixture.engine->atlas().take_patches();
    fixture.engine->begin_frame();
    CHECK(drawn(*fixture.engine, "ab", fixture.plex) == 1);
    CHECK(fixture.engine->atlas().evictions() == 1);
    std::ignore = fixture.engine->atlas().take_patches();
    fixture.engine->begin_frame();

    CHECK(drawn(*fixture.engine, "M", fixture.plex) == 1);
    CHECK(fixture.engine->atlas().evictions() == 2);
    CHECK_FALSE(fixture.engine->atlas().take_patches().empty());
}

TEST_CASE("a layout made at one scale is refused on a list of another") {
    const testing::fixture_engine fixture = testing::plex_engine();
    draw::draw_list list;
    list.reset({.size = {.width = 400, .height = 100}, .pixels_per_unit = 2.0F});
    const result<const text_layout*> made = fixture.engine->layout(request("scaled", fixture.plex));
    REQUIRE(made.has_value());
    const result<void> drawn_here =
        fixture.engine->draw(list, **made, {.x = 0.0F, .y = 0.0F}, draw::white);
    REQUIRE_FALSE(drawn_here.has_value());
    CHECK(drawn_here.error().code == error_code::malformed);
    CHECK(list.frame().records.empty());
}

}
}
