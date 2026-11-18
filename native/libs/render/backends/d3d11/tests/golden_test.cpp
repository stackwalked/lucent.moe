#include "golden.hpp"

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <format>
#include <string>
#include <system_error>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>
#include <dxgiformat.h>

#include <lucent/draw/color.hpp>
#include <lucent/draw/frame_data.hpp>

namespace lucent::d3d11::testing {
namespace {

constexpr draw::pixel_size tiny{.width = 4, .height = 3};

auto filled(draw::pixel_size size, draw::color fill) -> image {
    image pixels{.size = size, .rgba = {}};
    for (isize i = 0; i < isize{size.width} * isize{size.height}; ++i) {
        pixels.rgba.insert(
            pixels.rgba.end(),
            {std::byte{fill.r}, std::byte{fill.g}, std::byte{fill.b}, std::byte{fill.a}}
        );
    }
    return pixels;
}

auto golden_of(image pixels, std::string os_build) -> recorded_golden {
    return {.pixels = std::move(pixels), .os_build = std::move(os_build)};
}

constexpr draw::color grey{.r = 100, .g = 100, .b = 100, .a = 255};

TEST_CASE("a pixel within 3 of the golden in every channel still matches it") {
    image actual = filled(tiny, grey);
    actual.rgba.at(5) = std::byte{103};
    actual.rgba.at(10) = std::byte{97};

    const golden_outcome outcome = verdict(golden_of(filled(tiny, grey), "1.0"), actual, "1.0");

    CHECK(outcome.is_match);
    CHECK(outcome.report == "max channel delta 3, 0 pixels over tolerance 3");
}

TEST_CASE("a channel 4 away from the golden fails it, and the report counts that pixel") {
    image actual = filled(tiny, grey);
    actual.rgba.at(7) = std::byte{251};

    const golden_outcome outcome = verdict(golden_of(filled(tiny, grey), "1.0"), actual, "1.0");

    CHECK_FALSE(outcome.is_match);
    CHECK(outcome.report == "max channel delta 4, 1 pixels over tolerance 3");
}

TEST_CASE("an image of another size never matches its golden") {
    const image actual = filled(draw::pixel_size{.width = 3, .height = 4}, grey);

    const golden_outcome outcome = verdict(golden_of(filled(tiny, grey), "1.0"), actual, "1.0");

    CHECK_FALSE(outcome.is_match);
    CHECK(outcome.report == "size differs: golden 4x3, actual 3x4");
}

TEST_CASE("the report names drift only when the golden came from another OS build") {
    const image actual = filled(tiny, grey);

    const golden_outcome same =
        verdict(golden_of(filled(tiny, grey), "26100.4652"), actual, "26100.4652");
    const golden_outcome other =
        verdict(golden_of(filled(tiny, grey), "26100.4652"), actual, "26100.4770");

    CHECK_FALSE(same.report.contains("drift"));
    CHECK(other.is_match);
    CHECK(other.report.ends_with("\ndrift: golden from OS build 26100.4652, running 26100.4770"));
}

TEST_CASE("the OS build reads as the build number, a dot and the update revision") {
    const result<std::string> build = os_build();

    REQUIRE(build.has_value());
    const usize dot = build->find('.');
    REQUIRE(dot != std::string::npos);
    CHECK(dot > 0);
    CHECK(dot + 1 < build->size());
    CHECK(std::ranges::all_of(*build, [](char character) {
        return character == '.' || (character >= '0' && character <= '9');
    }));
}

constexpr draw::pixel_size smoke_size{.width = 16, .height = 16};
constexpr draw::color smoke_colour{.r = 200, .g = 100, .b = 30, .a = 128};

auto smoke_spec(DXGI_FORMAT format, u32 sample_count) -> target_spec {
    return {
        .size = smoke_size,
        .format = static_cast<u32>(format),
        .view_format = static_cast<u32>(format),
        .sample_count = sample_count,
    };
}

auto cleared_and_read(const target_spec& spec) -> result<image> {
    const warp_device device = LUCENT_TRY(warp_device::create());
    test_target target = LUCENT_TRY(test_target::create(device, spec));
    target.clear(smoke_colour);
    return read_back(device, target);
}

TEST_CASE("WARP reads back a cleared colour as stored on UNORM, BGRA sRGB and 4x MSAA targets") {
    const target_spec spec = GENERATE(
        smoke_spec(DXGI_FORMAT_R8G8B8A8_UNORM, 1),
        smoke_spec(DXGI_FORMAT_B8G8R8A8_UNORM_SRGB, 1),
        smoke_spec(DXGI_FORMAT_R8G8B8A8_UNORM, 4)
    );
    CAPTURE(spec.format, spec.sample_count);

    const result<image> pixels = cleared_and_read(spec);

    REQUIRE(pixels.has_value());
    CHECK(pixels->size.width == smoke_size.width);
    CHECK(pixels->size.height == smoke_size.height);
    CHECK(pixels->rgba == filled(smoke_size, smoke_colour).rgba);
}

TEST_CASE("a PNG written and read back keeps every byte, alpha included") {
    image pixels{.size = tiny, .rgba = {}};
    for (isize i = 0; i < isize{tiny.width} * isize{tiny.height} * 4; ++i) {
        pixels.rgba.push_back(static_cast<std::byte>((i * 37) % 256));
    }
    std::error_code located;
    const std::filesystem::path path =
        std::filesystem::temp_directory_path(located)
        / std::format("lucent_d3d11_golden_{}.png", GetCurrentProcessId());
    REQUIRE_FALSE(located);

    const result<void> written = write_png(path, pixels);
    const result<image> read = read_png(path);
    std::error_code removed;
    std::filesystem::remove(path, removed);

    REQUIRE(written.has_value());
    REQUIRE(read.has_value());
    CHECK(read->size.width == tiny.width);
    CHECK(read->size.height == tiny.height);
    CHECK(read->rgba == pixels.rgba);
}

}
}
