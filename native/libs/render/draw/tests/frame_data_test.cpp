#include <lucent/draw/frame_data.hpp>

#include <array>
#include <expected>
#include <limits>
#include <optional>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/color.hpp>
#include <lucent/draw/half.hpp>
#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>

#include "lucent/draw/rect.hpp"

// check() is the backend's only defence against a bad frame reaching the GPU, which would draw
// garbage or read past a buffer rather than fail loudly.

namespace lucent::draw {
namespace {

constexpr error malformed{.code = error_code::malformed};
constexpr pixel_size target{.width = 640, .height = 480};
constexpr pixel_rect whole{.left = 0, .top = 0, .right = 640, .bottom = 480};
constexpr rect box_at_origin{.min = {.x = 0.0F, .y = 0.0F}, .max = {.x = 10.0F, .y = 10.0F}};
constexpr layer no_layer{};
constexpr quad_run first_run{.clip = whole, .first = 0, .count = 1, .image = std::nullopt};

auto shape_record() -> quad_record {
    return {
        .rect = {0, 0, 10, 10},
        .geometry = {},
        .gradient = {},
        .style = {packed(white), packed(white), pack(record_kinds{}), 0},
    };
}

auto image_record() -> quad_record {
    quad_record record = shape_record();
    record.style[2] = pack(record_kinds{.quad = quad_kind::image});
    return record;
}

struct frame_parts {
    std::vector<quad_record> records{shape_record()};
    std::vector<path_vertex> vertices{3};
    std::vector<command> commands{first_run};
};

auto frame_of(const frame_parts& parts) -> frame_data {
    return {
        .target = target,
        .records = parts.records,
        .path_vertices = parts.vertices,
        .commands = parts.commands,
    };
}

}

TEST_CASE("a well-formed frame passes") {
    frame_parts parts;
    parts.records.push_back(image_record());
    parts.commands = {
        layer_begin{.surface = no_layer, .clip = whole},
        quad_run{.clip = whole, .first = 0, .count = 2, .image = image_handle{9}},
        path_run{.clip = whole, .first = 0, .count = 3},
        layer_end{},
    };
    CHECK(check(frame_of(parts)).has_value());
}

TEST_CASE("an empty or oversized target is refused") {
    const frame_parts parts;
    frame_data frame = frame_of(parts);
    frame.target = {.width = 0, .height = 480};
    CHECK(check(frame) == std::unexpected(malformed));
    frame.target = {.width = 16'385, .height = 480};
    CHECK(check(frame) == std::unexpected(malformed));
}

TEST_CASE("a run outside its buffer or a clip outside the target is refused") {
    frame_parts parts;
    SECTION("records past the end") {
        parts.commands = {quad_run{.clip = whole, .first = 0, .count = 2, .image = std::nullopt}};
    }
    SECTION("an empty run") {
        parts.commands = {quad_run{.clip = whole, .first = 0, .count = 0, .image = std::nullopt}};
    }
    SECTION("vertices that are not whole triangles") {
        parts.commands = {path_run{.clip = whole, .first = 1, .count = 2}};
    }
    SECTION("a clip past the target") {
        parts.commands = {
            quad_run{
                .clip = {.left = 0, .top = 0, .right = 641, .bottom = 480},
                .first = 0,
                .count = 1,
                .image = std::nullopt,
            },
        };
    }
    SECTION("an inverted clip") {
        parts.commands = {
            quad_run{
                .clip = {.left = 10, .top = 0, .right = 5, .bottom = 480},
                .first = 0,
                .count = 1,
                .image = std::nullopt,
            },
        };
    }
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

TEST_CASE("an image record in a run that binds no image is refused") {
    frame_parts parts;
    parts.records = {image_record()};
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

TEST_CASE("unbalanced or too deeply nested layers are refused") {
    frame_parts parts;
    SECTION("an end with no begin") {
        parts.commands = {layer_end{}};
    }
    SECTION("a begin never ended") {
        parts.commands = {layer_begin{.surface = no_layer, .clip = whole}};
    }
    SECTION("nine deep") {
        parts.commands.assign(9, layer_begin{.surface = no_layer, .clip = whole});
        parts.commands.insert(parts.commands.end(), 9, layer_end{});
    }
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

TEST_CASE("a record with unknown kinds or a number that isn't finite is refused") {
    frame_parts parts;
    SECTION("unknown kind bits") {
        parts.records.front().style[2] = 0x0000'0100U;
    }
    SECTION("a NaN in the rect") {
        parts.records.front().rect[1] = std::numeric_limits<f32>::quiet_NaN();
    }
    SECTION("an infinite gradient point") {
        parts.records.front().gradient[0] = std::numeric_limits<f32>::infinity();
    }
    SECTION("an infinite half") {
        parts.records.front().style[3] = u32{to_half(1.0e9F)};
    }
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

TEST_CASE("a layer outside the ranges the list records is refused") {
    frame_parts parts;
    layer surface{
        .bounds = box_at_origin,
        .radius = 4.0F,
        .opacity = 1.0F,
        .blur = 8.0F,
        .rim = 2.0F,
    };
    SECTION("a negative blur") {
        surface.blur = -1.0F;
    }
    SECTION("a blur past the backend's bound") {
        surface.blur = 1.0e6F;
    }
    SECTION("opacity above one") {
        surface.opacity = 1.5F;
    }
    SECTION("a negative radius") {
        surface.radius = -2.0F;
    }
    SECTION("a rim with no blur to bend") {
        surface.blur = 0.0F;
    }
    parts.commands = {layer_begin{.surface = surface, .clip = whole}, layer_end{}};
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

TEST_CASE("a negative softness or stroke width is refused") {
    frame_parts parts;
    SECTION("softness") {
        parts.records.front().style[3] = u32{to_half(-1.0F)};
    }
    SECTION("stroke") {
        parts.records.front().style[3] = u32{to_half(-1.0F)} << 16U;
    }
    CHECK(check(frame_of(parts)) == std::unexpected(malformed));
}

}
