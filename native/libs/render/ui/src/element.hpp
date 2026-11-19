#pragma once

#include <array>
#include <optional>
#include <utility>
#include <variant>

#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui::detail {

enum class axis : u8 {
    x,
    y,
};

// Where an axis's value sits in an element's per-axis arrays.
constexpr auto index_of(axis along) -> usize {
    return std::to_underlying(along);
}

inline constexpr usize x_axis = index_of(axis::x);
inline constexpr usize y_axis = index_of(axis::y);

struct no_leaf {};

struct text_leaf {
    // The UTF-8, in the frame's string buffer.
    isize begin = 0;
    isize size = 0;
    text::text_style style;
    draw::color ink;
    text::text_wrap wrap = text::text_wrap::none;
    text::text_overflow overflow = text::text_overflow::visible;
    std::optional<isize> max_lines;
    f32 natural_width = 0.0F;
    // Borrowed from the text system until its next frame.
    const text::text_layout* laid_out = nullptr;
};

struct icon_leaf {
    text::icon drawn;
    draw::color tint;
};

struct custom_leaf {
    // Into the frame's drawers.
    isize drawer = 0;
};

using leaf = std::variant<no_leaf, text_leaf, icon_leaf, custom_leaf>;

enum class root_layer : u8 {
    window,
    popup,
};

// One declared element. Elements sit in declaration order (pre-order), so a subtree is the
// contiguous run [index, end) and every child comes after its parent; a popup declared inside
// another root's subtree sits in that run too but belongs to its own root.
struct element {
    element_id id{};
    box_style style;
    leaf content;
    bool is_scroll = false;
    // Indices into the frame's elements, and roots for root.
    isize parent = -1;
    isize root = 0;
    isize first_child = -1;
    isize last_child = -1;
    isize next_sibling = -1;
    isize child_count = 0;
    isize end = 0;

    // Layout, per axis.
    std::array<f32, 2> size{};
    std::array<f32, 2> position{};
    // What the children take up, padding included: a fit size before its rule clamps it.
    std::array<f32, 2> extent{};
    // The least it shrinks to.
    std::array<f32, 2> floor{};
    f32 scroll_offset = 0.0F;
    // What its rect is cut by: the viewport and every scroll it sits in. Only what is inside can be
    // seen or hit.
    draw::rect clip{};
};

struct root_entry {
    element_id id{};
    isize element = 0;
    root_layer layer = root_layer::window;
    draw::vec2 position;
    // A popup's anchor this frame: its element when declared before the popup, else last frame's
    // rect.
    std::optional<isize> anchor_element;
    std::optional<draw::rect> anchor_rect;
};

constexpr auto rect_of(const element& laid_out) -> draw::rect {
    return {
        .min = {.x = laid_out.position[x_axis], .y = laid_out.position[y_axis]},
        .max = {
            .x = laid_out.position[x_axis] + laid_out.size[x_axis],
            .y = laid_out.position[y_axis] + laid_out.size[y_axis],
        },
    };
}

}
