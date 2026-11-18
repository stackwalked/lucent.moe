#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <format>
#include <numbers>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>
#include <catch2/generators/catch_generators_range.hpp>
#include <dxgiformat.h>

#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/arc.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/frame_data.hpp>
#include <lucent/draw/glyph_run.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/path_stroke.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/segment.hpp>
#include <lucent/draw/vec2.hpp>

#include "golden.hpp"

namespace lucent::d3d11::testing {
namespace {

constexpr draw::pixel_size scene_size{.width = 128, .height = 128};
constexpr draw::color backdrop{.r = 30, .g = 34, .b = 42, .a = 255};

// A target the renderer meets in a swap chain, named as its goldens are.
struct target_case {
    std::string_view name;
    target_spec spec;
};

auto target_case_of(std::string_view name, DXGI_FORMAT texture, DXGI_FORMAT view, u32 samples)
    -> target_case {
    return {
        .name = name,
        .spec = {
            .size = scene_size,
            .format = static_cast<u32>(texture),
            .view_format = static_cast<u32>(view),
            .sample_count = samples,
        },
    };
}

auto every_target() -> std::array<target_case, 5> {
    return {
        target_case_of("unorm", DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, 1),
        target_case_of("srgb", DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, 1),
        target_case_of(
            "typeless", DXGI_FORMAT_R8G8B8A8_TYPELESS, DXGI_FORMAT_R8G8B8A8_UNORM_SRGB, 1
        ),
        target_case_of("bgra", DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_B8G8R8A8_UNORM, 1),
        target_case_of("msaa", DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, 4),
    };
}

auto box(f32 left, f32 top, f32 right, f32 bottom) -> draw::rect {
    return {.min = {.x = left, .y = top}, .max = {.x = right, .y = bottom}};
}

constexpr auto rgba(u8 red, u8 green, u8 blue, u8 alpha) -> draw::color {
    return {.r = red, .g = green, .b = blue, .a = alpha};
}

using scene = auto (*)(draw::draw_list& list, renderer& drawer) -> void;

// Per-corner radii, a stroke inside its edge, a translucent circle, an arc whose start is past a
// full turn, butt and round segments, and a level hairline on whole pixels.
auto shapes(draw::draw_list& list, renderer& /*drawer*/) -> void {
    list.fill(
        draw::rounded_rect{
            .bounds = box(8, 8, 60, 48),
            .radii = {.top_left = 0, .top_right = 6, .bottom_right = 14, .bottom_left = 22},
        },
        draw::solid(rgba(40, 180, 170, 255))
    );
    list.stroke(
        draw::rounded_rect{.bounds = box(68, 8, 120, 48), .radii = draw::uniform(10)},
        draw::solid(rgba(250, 150, 40, 255)),
        {.width = 3, .ends = draw::cap::butt}
    );
    list.fill(
        draw::circle{.centre = {.x = 26, .y = 76}, .radius = 16},
        draw::solid(rgba(255, 255, 255, 160))
    );
    list.stroke(
        draw::circle{.centre = {.x = 26, .y = 76}, .radius = 16},
        draw::solid(rgba(230, 70, 120, 255)),
        {.width = 2, .ends = draw::cap::butt}
    );
    list.stroke(
        draw::arc{
            .centre = {.x = 66, .y = 76},
            .radius = 15,
            .start = (2.0F * std::numbers::pi_v<f32>)+2.5F,
            .sweep = 4.0F,
        },
        draw::solid(rgba(240, 90, 200, 255)),
        {.width = 5, .ends = draw::cap::round}
    );
    list.stroke(
        draw::segment{.from = {.x = 90, .y = 62}, .to = {.x = 120, .y = 82}},
        draw::solid(rgba(250, 220, 60, 255)),
        {.width = 6, .ends = draw::cap::butt}
    );
    list.stroke(
        draw::segment{.from = {.x = 92, .y = 100}, .to = {.x = 118, .y = 90}},
        draw::solid(rgba(120, 200, 255, 255)),
        {.width = 6, .ends = draw::cap::round}
    );
    list.stroke(
        draw::segment{.from = {.x = 8, .y = 112.3F}, .to = {.x = 120, .y = 112.3F}},
        draw::solid(rgba(255, 255, 255, 255)),
        {.width = 1, .ends = draw::cap::butt}
    );
}

// A horizontal and a diagonal linear gradient, translucent ends included, and grain.
auto paints(draw::draw_list& list, renderer& /*drawer*/) -> void {
    list.fill(
        draw::rounded_rect{.bounds = box(8, 8, 120, 40), .radii = draw::uniform(8)},
        {
            .kind = draw::paint_kind::linear,
            .from = rgba(255, 60, 60, 255),
            .to = rgba(60, 90, 255, 255),
            .start = {.x = 8, .y = 0},
            .end = {.x = 120, .y = 0},
        }
    );
    list.fill(
        draw::circle{.centre = {.x = 36, .y = 84}, .radius = 28},
        {
            .kind = draw::paint_kind::linear,
            .from = rgba(255, 230, 80, 255),
            .to = rgba(40, 220, 140, 0),
            .start = {.x = 8, .y = 56},
            .end = {.x = 64, .y = 112},
        }
    );
    list.fill(
        draw::rounded_rect{.bounds = box(72, 52, 120, 120), .radii = draw::uniform(6)},
        draw::noise(rgba(255, 255, 255, 200))
    );
}

// Soft copies under cards: offset, spread, and a coloured glow; the cards drawn over them.
auto shadows(draw::draw_list& list, renderer& /*drawer*/) -> void {
    const draw::rounded_rect card{.bounds = box(16, 16, 64, 56), .radii = draw::uniform(8)};
    list.shadow(
        card, {.tint = rgba(0, 0, 0, 200), .blur = 6, .spread = 0, .offset = {.x = 0, .y = 6}}
    );
    list.fill(card, draw::solid(rgba(235, 235, 240, 255)));
    const draw::rounded_rect pill{.bounds = box(72, 24, 112, 48), .radii = draw::uniform(12)};
    list.shadow(
        pill, {.tint = rgba(80, 160, 255, 255), .blur = 4, .spread = 4, .offset = {.x = 0, .y = 0}}
    );
    list.fill(pill, draw::solid(rgba(30, 60, 120, 255)));
    const draw::rounded_rect slab{.bounds = box(24, 80, 104, 108), .radii = draw::uniform(0)};
    list.shadow(
        slab, {.tint = rgba(0, 0, 0, 255), .blur = 12, .spread = -2, .offset = {.x = 4, .y = 4}}
    );
    list.fill(slab, draw::solid(rgba(200, 80, 60, 255)));
}

// A convex hexagon, a concave star filled even where it folds in, and a stroke that tapers and
// fades point by point.
auto paths(draw::draw_list& list, renderer& /*drawer*/) -> void {
    constexpr f32 half_turn = std::numbers::pi_v<f32>;
    std::vector<draw::vec2> hexagon;
    for (const i32 i : std::views::iota(0, 6)) {
        const f32 angle = static_cast<f32>(i) * half_turn / 3.0F;
        hexagon.push_back({.x = 32 + (24 * std::cos(angle)), .y = 36 + (24 * std::sin(angle))});
    }
    std::vector<draw::vec2> star;
    for (const i32 i : std::views::iota(0, 10)) {
        const f32 angle = (static_cast<f32>(i) * half_turn / 5.0F) - (half_turn / 2.0F);
        const f32 radius = i % 2 == 0 ? 26.0F : 11.0F;
        star.push_back(
            {.x = 94 + (radius * std::cos(angle)), .y = 38 + (radius * std::sin(angle))}
        );
    }
    list.fill_convex(hexagon, rgba(80, 200, 120, 255));
    list.fill_polygon(star, rgba(250, 200, 60, 255));
    const std::array points{
        draw::vec2{.x = 10, .y = 110},
        draw::vec2{.x = 40, .y = 74},
        draw::vec2{.x = 72, .y = 112},
        draw::vec2{.x = 118, .y = 76},
    };
    const std::array tints{
        rgba(255, 80, 80, 255),
        rgba(255, 255, 255, 255),
        rgba(80, 160, 255, 255),
        rgba(80, 160, 255, 40),
    };
    const std::array widths{2.0F, 8.0F, 5.0F, 12.0F};
    list.stroke(
        draw::path_stroke{
            .points = points,
            .tints = tints,
            .widths = widths,
            .tint = draw::white,
            .width = 1,
            .feather = 1,
            .ends = draw::path_end::open,
        }
    );
}

// Stripes to see through; a blurred rounded pane with a rim and a light key; a translucent group
// whose overlapping circles fade as one; a rounded clip with no pass; and a blurred pane nested in
// the translucent group.
auto layers(draw::draw_list& list, renderer& /*drawer*/) -> void {
    for (const i32 i : std::views::iota(0, 8)) {
        const auto left = static_cast<f32>(i * 16);
        const bool is_even = i % 2 == 0;
        list.fill(
            draw::rounded_rect{.bounds = box(left, 0, left + 16, 128), .radii = draw::uniform(0)},
            draw::solid(is_even ? rgba(240, 240, 240, 255) : rgba(220, 60, 50, 255))
        );
    }
    list.fill(
        draw::circle{.centre = {.x = 40, .y = 40}, .radius = 10}, draw::solid(rgba(20, 20, 20, 255))
    );

    list.push_layer({
        .bounds = box(8, 8, 72, 72),
        .radius = 14,
        .opacity = 1,
        .blur = 5,
        .rim = 4,
        .light = draw::light_key{7},
    });
    list.fill(
        draw::rounded_rect{.bounds = box(8, 8, 72, 72), .radii = draw::uniform(14)},
        draw::solid(rgba(255, 255, 255, 40))
    );
    list.pop_layer();

    list.push_layer(
        draw::layer{.bounds = box(80, 8, 120, 56), .radius = 12, .opacity = 1, .blur = 0}
    );
    list.fill(
        draw::rounded_rect{.bounds = box(70, 0, 128, 64), .radii = draw::uniform(0)},
        draw::solid(rgba(40, 120, 230, 255))
    );
    list.pop_layer();

    list.push_layer(
        draw::layer{.bounds = box(8, 64, 120, 120), .radius = 10, .opacity = 0.5F, .blur = 0}
    );
    list.fill(
        draw::circle{.centre = {.x = 36, .y = 92}, .radius = 22},
        draw::solid(rgba(20, 200, 90, 255))
    );
    list.fill(
        draw::circle{.centre = {.x = 56, .y = 92}, .radius = 22},
        draw::solid(rgba(20, 200, 90, 255))
    );
    list.push_layer(
        draw::layer{.bounds = box(84, 72, 116, 112), .radius = 6, .opacity = 1, .blur = 12}
    );
    list.fill(
        draw::rounded_rect{.bounds = box(84, 72, 116, 112), .radii = draw::uniform(6)},
        draw::solid(rgba(0, 0, 0, 60))
    );
    list.pop_layer();
    list.pop_layer();
}

// Two atlas pages filled with synthetic coverage: a soft disc on page 0 and a checker on page 3,
// tinted per glyph in one run.
constexpr i32 cell = 24;

auto disc_coverage() -> std::vector<std::byte> {
    std::vector<std::byte> coverage;
    for (const i32 y : std::views::iota(0, cell)) {
        for (const i32 x : std::views::iota(0, cell)) {
            const f32 across = static_cast<f32>(x) + 0.5F - (cell / 2.0F);
            const f32 down = static_cast<f32>(y) + 0.5F - (cell / 2.0F);
            const f32 inside =
                std::clamp(11.0F - std::sqrt((across * across) + (down * down)), 0.0F, 1.0F);
            coverage.push_back(static_cast<std::byte>(static_cast<u8>(inside * 255.0F)));
        }
    }
    return coverage;
}

auto checker_coverage() -> std::vector<std::byte> {
    std::vector<std::byte> coverage;
    for (const i32 y : std::views::iota(0, cell)) {
        for (const i32 x : std::views::iota(0, cell)) {
            const bool is_lit = ((x / 4) + (y / 4)) % 2 == 0;
            coverage.push_back(is_lit ? std::byte{255} : std::byte{64});
        }
    }
    return coverage;
}

auto atlas_pages(draw::draw_list& list, renderer& drawer) -> void {
    const std::vector<std::byte> disc = disc_coverage();
    const std::vector<std::byte> checker = checker_coverage();
    const std::array uploads{
        atlas_upload{
            .page = draw::atlas_page{0},
            .area = {.left = 0, .top = 0, .right = cell, .bottom = cell},
            .coverage = disc,
            .row_pitch = cell,
        },
        atlas_upload{
            .page = draw::atlas_page{3},
            .area = {.left = 512, .top = 512, .right = 512 + cell, .bottom = 512 + cell},
            .coverage = checker,
            .row_pitch = cell,
        },
    };
    drawer.upload_atlas(uploads);
    constexpr f32 size = draw::atlas_page_size;
    const draw::rect disc_uv = box(0, 0, cell / size, cell / size);
    const draw::rect checker_uv =
        box(512 / size, 512 / size, (512 + cell) / size, (512 + cell) / size);
    const auto glyph =
        [](draw::atlas_page page, f32 x, f32 y, draw::rect texture_box, draw::color tint) {
            return draw::glyph_quad{
                .page = page,
                .bounds = box(x, y, x + cell, y + cell),
                .uv = texture_box,
                .tint = tint,
            };
        };
    const std::array glyphs{
        glyph(draw::atlas_page{0}, 0, 0, disc_uv, rgba(255, 255, 255, 255)),
        glyph(draw::atlas_page{3}, 32, 0, checker_uv, rgba(255, 200, 60, 255)),
        glyph(draw::atlas_page{0}, 64, 0, disc_uv, rgba(80, 200, 255, 160)),
        glyph(draw::atlas_page{3}, 0, 40, checker_uv, rgba(255, 255, 255, 255)),
        glyph(draw::atlas_page{0}, 32, 40, disc_uv, rgba(255, 80, 120, 255)),
        glyph(draw::atlas_page{3}, 64, 40, checker_uv, rgba(120, 255, 120, 128)),
    };
    list.draw(draw::glyph_run{.origin = {.x = 16, .y = 24}, .glyphs = glyphs});
}

// A 4x4 image: hues across, alpha falling down the rows, so straight alpha is premultiplied before
// it is filtered.
auto test_image() -> std::vector<std::byte> {
    std::vector<std::byte> rgba_bytes;
    for (const i32 y : std::views::iota(0, 4)) {
        for (const i32 x : std::views::iota(0, 4)) {
            rgba_bytes.push_back(static_cast<std::byte>(x * 80));
            rgba_bytes.push_back(static_cast<std::byte>(255 - (x * 60)));
            rgba_bytes.push_back(static_cast<std::byte>(y * 80));
            rgba_bytes.push_back(static_cast<std::byte>(255 - (y * 60)));
        }
    }
    return rgba_bytes;
}

// An image scaled and filtered, the same image tinted, and a stale handle that draws nothing while
// the shape sharing its run still draws.
auto images(draw::draw_list& list, renderer& drawer) -> void {
    const std::vector<std::byte> pixels = test_image();
    const image_pixels described{
        .size = {.width = 4, .height = 4},
        .rgba = pixels,
        .row_pitch = 16,
    };
    const result<draw::image_handle> image = drawer.create_image(described);
    const result<draw::image_handle> stale = drawer.create_image(described);
    REQUIRE(image.has_value());
    REQUIRE(stale.has_value());
    drawer.destroy_image(*stale);

    list.draw(draw::image_quad{.image = *image, .bounds = box(8, 8, 56, 56)});
    list.draw(
        draw::image_quad{
            .image = *image,
            .bounds = box(72, 8, 120, 56),
            .tint = rgba(255, 120, 120, 200),
        }
    );
    list.draw(draw::image_quad{.image = *stale, .bounds = box(8, 72, 56, 120)});
    list.fill(
        draw::rounded_rect{.bounds = box(72, 72, 120, 120), .radii = draw::uniform(8)},
        draw::solid(rgba(60, 220, 120, 255))
    );
}

auto render_scene(const target_case& target_kind, scene record) -> result<image> {
    const warp_device device = LUCENT_TRY(warp_device::create());
    test_target target = LUCENT_TRY(test_target::create(device, target_kind.spec));
    target.clear(backdrop);
    renderer drawer = LUCENT_TRY(renderer::from_device(device.device(), device.context()));
    LUCENT_TRY(drawer.build());
    draw::draw_list list;
    list.reset({.size = scene_size, .pixels_per_unit = 1});
    record(list, drawer);
    LUCENT_TRY(drawer.render(list.frame(), target.as_render_target()));
    return read_back(device, target);
}

auto check_scene(std::string_view name, scene record) -> void {
    const target_case target_kind = GENERATE(from_range(every_target()));
    const std::string golden = std::format("{}_{}", name, target_kind.name);
    CAPTURE(golden);

    const result<image> drawn = render_scene(target_kind, record);

    REQUIRE(drawn.has_value());
    const golden_outcome outcome = check_golden(golden, *drawn);
    INFO(outcome.report);
    CHECK(outcome.is_match);
}

TEST_CASE("shapes match their goldens on every target") {
    check_scene("shapes", shapes);
}

TEST_CASE("paints match their goldens on every target") {
    check_scene("paints", paints);
}

TEST_CASE("shadows match their goldens on every target") {
    check_scene("shadows", shadows);
}

TEST_CASE("paths match their goldens on every target") {
    check_scene("paths", paths);
}

TEST_CASE("layers match their goldens on every target") {
    check_scene("layers", layers);
}

TEST_CASE("two atlas pages match their goldens on every target") {
    check_scene("atlas", atlas_pages);
}

TEST_CASE("images and a stale handle match their goldens on every target") {
    check_scene("images", images);
}

}
}
