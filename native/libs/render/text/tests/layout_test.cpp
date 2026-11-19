#include <algorithm>
#include <cmath>
#include <iterator>
#include <optional>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/text/text_layout.hpp>

#include "../src/text_engine.hpp"
#include "fixture.hpp"

namespace lucent::text {
namespace {

// The two paths add the same floats in different orders.
constexpr f32 tolerance = 0.001F;

struct shape {
    f32 max_width = 0.0F;
    text_wrap wrap = text_wrap::none;
    text_overflow overflow = text_overflow::visible;
    std::optional<isize> max_lines;
};

auto request(std::string_view utf8, face_id face, const shape& with) -> layout_request {
    return {
        .utf8 = utf8,
        .style = {.face = face, .size = 16.0F},
        .max_width = with.max_width,
        .wrap = with.wrap,
        .overflow = with.overflow,
        .max_lines = with.max_lines,
        .pixels_per_unit = 1.0F,
    };
}

auto request(std::string_view utf8, face_id face) -> layout_request {
    return request(
        utf8,
        face,
        {
            .max_width = 0.0F,
            .wrap = text_wrap::none,
            .overflow = text_overflow::visible,
            .max_lines = std::nullopt,
        }
    );
}

auto laid_out(text_engine& engine, const layout_request& asked, layout_path path)
    -> std::optional<text_layout> {
    result<std::optional<text_layout>> made = engine.layout_by(asked, path);
    LUCENT_INVARIANT(made.has_value());
    return *std::move(made);
}

// The tests that ask for one path's layout ask only for text it takes.
auto made_by(text_engine& engine, const layout_request& asked, layout_path path) -> text_layout {
    std::optional<text_layout> made = laid_out(engine, asked, path);
    LUCENT_INVARIANT(made.has_value());
    return *std::move(made);
}

auto shaped(text_engine& engine, const layout_request& asked) -> text_layout {
    return made_by(engine, asked, layout_path::shaped);
}

auto is_near(f32 left, f32 right) -> bool {
    return std::abs(left - right) <= tolerance;
}

auto is_same_line(const text_line& quick, const text_line& full) -> bool {
    return quick.first_glyph == full.first_glyph
           && quick.glyph_count == full.glyph_count
           && quick.text_begin == full.text_begin
           && quick.text_end == full.text_end
           && is_near(quick.width, full.width);
}

auto is_same_glyph(const placed_glyph& quick, const placed_glyph& full) -> bool {
    return quick.face == full.face
           && quick.index == full.index
           && is_near(quick.pen.x, full.pen.x)
           && is_near(quick.pen.y, full.pen.y)
           && is_near(quick.advance, full.advance)
           && quick.text_offset == full.text_offset;
}

auto check_agree(const text_layout& fast, const text_layout& slow) -> void {
    CHECK(std::ranges::equal(fast.lines, slow.lines, is_same_line));
    CHECK(std::ranges::equal(fast.glyphs, slow.glyphs, is_same_glyph));
    CHECK(is_near(fast.size.x, slow.size.x));
    CHECK(is_near(fast.size.y, slow.size.y));
    CHECK(fast.is_truncated == slow.is_truncated);
}

auto agreeing(text_engine& engine, const layout_request& asked) -> text_layout {
    const text_layout fast = made_by(engine, asked, layout_path::fast);
    const text_layout slow = shaped(engine, asked);
    check_agree(fast, slow);
    return slow;
}

auto texts_of(const text_layout& layout, std::string_view utf8) -> std::vector<std::string_view> {
    std::vector<std::string_view> texts;
    texts.reserve(layout.lines.size());
    for (const text_line& line : layout.lines) {
        texts.push_back(utf8.substr(
            static_cast<usize>(line.text_begin), static_cast<usize>(line.text_end - line.text_begin)
        ));
    }
    return texts;
}

TEST_CASE("the fast path places kerned Latin glyphs where IDWriteTextLayout does") {
    const testing::fixture_engine fixture = testing::plex_engine();
    for (const std::string_view text : {"AVATAR Today", "Wave 42, yes.", "x", "", "Hello world"}) {
        CAPTURE(text);
        std::ignore = agreeing(*fixture.engine, request(text, fixture.plex));
    }
}

TEST_CASE("the fast path kerns: a pair's advance differs from the glyph's own") {
    const testing::fixture_engine fixture = testing::plex_engine();

    const text_layout kerned = agreeing(*fixture.engine, request("AV", fixture.plex));
    const text_layout plain = agreeing(*fixture.engine, request("AH", fixture.plex));

    CHECK_FALSE(is_near(kerned.glyphs.front().advance, plain.glyphs.front().advance));
}

TEST_CASE("the fast path refuses text that needs shaping, bidi or fallback") {
    const testing::fixture_engine fixture = testing::plex_engine();
    // A ligature, a combining mark, right-to-left letters, a bidi control, and a symbol the face
    // lacks.
    for (const std::string_view text :
        {"fit", "e\u0301", "\u05d0\u05d1", "a\u202eb\u202c", "\u2500", "tab\there"}) {
        CAPTURE(text);
        CHECK(
            laid_out(*fixture.engine, request(text, fixture.plex), layout_path::fast)
            == std::nullopt
        );
    }
}

TEST_CASE("utf-8 offsets count bytes, not code units") {
    const testing::fixture_engine fixture = testing::plex_engine();

    const text_layout made = agreeing(*fixture.engine, request("\u00e9t\u00e9", fixture.plex));

    REQUIRE(made.glyphs.size() == 3);
    CHECK(made.glyphs.at(0).text_offset == 0);
    CHECK(made.glyphs.at(1).text_offset == 2);
    CHECK(made.glyphs.at(2).text_offset == 3);
    CHECK(made.lines.front().text_end == 5);
}

TEST_CASE("lines break after spaces, alike on both paths, trailing spaces outside the width") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "Hello world, this is wrapping";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {.max_width = 80.0F, .wrap = text_wrap::words, .overflow = {}, .max_lines = {}}
        )
    );

    CHECK(
        texts_of(made, text)
        == std::vector<std::string_view>{"Hello ", "world, this ", "is ", "wrapping"}
    );
    CHECK(is_near(made.size.y, 4 * made.line_height));
    for (const text_line& line : made.lines) {
        CHECK(line.width <= 80.0F);
    }
}

TEST_CASE("a word wider than the line breaks inside itself, alike on both paths") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "Supercalifragilistic";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {.max_width = 50.0F, .wrap = text_wrap::words, .overflow = {}, .max_lines = {}}
        )
    );

    CHECK(made.lines.size() > 2);
    for (const text_line& line : made.lines) {
        CHECK(line.width <= 50.0F);
        CHECK(line.text_end > line.text_begin);
    }
}

TEST_CASE("an ellipsis takes the place of what doesn't fit, without the spaces before it") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "abc def ghi jkl mno pqr";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {.max_width = 70.0F, .wrap = {}, .overflow = text_overflow::ellipsis, .max_lines = {}}
        )
    );

    CHECK(made.is_truncated);
    CHECK(texts_of(made, text) == std::vector<std::string_view>{"abc def"});
    CHECK(made.size.x <= 70.0F);
    CHECK(made.glyphs.back().text_offset == 7);
}

TEST_CASE("max_lines with an ellipsis cuts the last line it keeps") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "abc def ghi jkl mno pqr";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {
                .max_width = 70.0F,
                .wrap = text_wrap::words,
                .overflow = text_overflow::ellipsis,
                .max_lines = 2,
            }
        )
    );

    CHECK(made.is_truncated);
    CHECK(texts_of(made, text) == std::vector<std::string_view>{"abc def ", "ghi jkl"});
}

TEST_CASE("max_lines without an ellipsis drops the lines past it") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "abc def ghi jkl mno pqr";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {.max_width = 70.0F, .wrap = text_wrap::words, .overflow = {}, .max_lines = 1}
        )
    );

    CHECK(made.is_truncated);
    CHECK(texts_of(made, text) == std::vector<std::string_view>{"abc def "});
}

TEST_CASE("text that fits draws whole, with no ellipsis") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const std::string_view text = "abc def";

    const text_layout made = agreeing(
        *fixture.engine,
        request(
            text,
            fixture.plex,
            {.max_width = 500.0F, .wrap = {}, .overflow = text_overflow::ellipsis, .max_lines = {}}
        )
    );

    CHECK_FALSE(made.is_truncated);
    CHECK(made.glyphs.size() == text.size());
}

TEST_CASE("a right-to-left override draws its letters in reverse order") {
    const testing::fixture_engine fixture = testing::plex_engine();
    // "ab", then "cde" overridden to right to left, then "f".
    const std::string_view text = "ab\u202ecde\u202cf";

    const text_layout made = shaped(*fixture.engine, request(text, fixture.plex));

    std::vector<placed_glyph> inked;
    std::ranges::copy_if(made.glyphs, std::back_inserter(inked), [](const placed_glyph& glyph) {
        return glyph.advance > 0.0F;
    });
    std::ranges::sort(inked, {}, [](const placed_glyph& glyph) { return glyph.pen.x; });
    std::vector<isize> visual(inked.size());
    std::ranges::transform(inked, visual.begin(), &placed_glyph::text_offset);
    // a, b, then e, d, c past the override's three bytes, then f past the pop's three.
    CHECK(visual == std::vector<isize>{0, 1, 7, 6, 5, 11});
}

TEST_CASE("a character our face lacks comes from our fallback chain before the system's") {
    const testing::fixture_engine fixture = testing::plex_engine();
    const result<face_id> geist =
        fixture.engine->add_face(testing::fixture_bytes("geist-mono.woff2"));
    REQUIRE(geist.has_value());
    REQUIRE(fixture.engine->set_fallback({&*geist, 1}).has_value());

    const text_layout made = shaped(*fixture.engine, request("a\u2192b", fixture.plex));

    REQUIRE(made.glyphs.size() == 3);
    CHECK(made.glyphs.at(0).face == fixture.plex);
    CHECK(made.glyphs.at(1).face == *geist);
    CHECK(made.glyphs.at(2).face == fixture.plex);
}

TEST_CASE("a character none of our faces has comes from some system face") {
    const testing::fixture_engine fixture = testing::plex_engine();

    const text_layout made = shaped(*fixture.engine, request("a\u6f22", fixture.plex));

    REQUIRE(made.glyphs.size() == 2);
    CHECK(made.glyphs.at(0).face == fixture.plex);
    CHECK_FALSE(fixture.engine->is_ours(made.glyphs.at(1).face));
}

TEST_CASE("a fallback face keeps the style's line height and baseline") {
    const testing::fixture_engine fixture = testing::plex_engine();

    const text_layout latin = agreeing(*fixture.engine, request("ab", fixture.plex));
    const text_layout mixed = shaped(*fixture.engine, request("a\u6f22", fixture.plex));

    CHECK(is_near(mixed.line_height, latin.line_height));
    CHECK(is_near(mixed.size.y, latin.size.y));
    for (const placed_glyph& glyph : mixed.glyphs) {
        CHECK(is_near(glyph.pen.y, latin.glyphs.front().pen.y));
    }
}

}
}
