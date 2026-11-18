#pragma once

#include <optional>
#include <span>
#include <variant>

#include <lucent/draw/image_quad.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/path_vertex.hpp>
#include <lucent/draw/quad_record.hpp>

namespace lucent::draw {

// Whole target pixels, right and bottom exclusive.
struct pixel_rect {
    i32 left = 0;
    i32 top = 0;
    i32 right = 0;
    i32 bottom = 0;

    auto operator==(const pixel_rect&) const -> bool = default;
};

struct pixel_size {
    i32 width = 0;
    i32 height = 0;
};

// Records [first, first + count), instanced under one scissor. Atlas and shape records ignore the
// image, so they join any run; only image records need it, and two images never share a run.
struct quad_run {
    pixel_rect clip;
    isize first = 0;
    isize count = 0;
    std::optional<image_handle> image;
};

// Path vertices [first, first + count) as a triangle list under one scissor.
struct path_run {
    pixel_rect clip;
    isize first = 0;
    isize count = 0;
};

// Opens a surface. Its fields are in target pixels; clip is the scissor in effect when it opened,
// which bounds the backdrop it blurs. A surface that misses its clip records nothing inside,
// and the backend skips its passes. Commands up to the matching layer_end draw into it.
struct layer_begin {
    layer surface;
    pixel_rect clip;
};

struct layer_end {};

using command = std::variant<quad_run, path_run, layer_begin, layer_end>;

// One list's frame, borrowed from it: valid until the list records again.
struct frame_data {
    pixel_size target;
    std::span<const quad_record> records;
    std::span<const path_vertex> path_vertices;
    std::span<const command> commands;
};

// Everything the backend relies on, checked once per frame: ranges inside the buffers, clips inside
// the target, layers balanced and within draw_list's depth, every record's kinds valid and every
// number finite, image records only in runs that bind an image. A frame that fails is refused whole
// as error_code::malformed. A target with no pixels (a minimised window) is refused too: the glue
// skips that frame rather than drawing it.
auto check(const frame_data& frame) -> result<void>;

}
