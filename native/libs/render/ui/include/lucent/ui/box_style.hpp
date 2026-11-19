#pragma once

#include <limits>
#include <optional>

#include <lucent/draw/color.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/draw/vec2.hpp>

namespace lucent::ui {

enum class size_kind : u8 {
    // As big as the content.
    fit,
    // value units.
    fixed,
    // A share, weighted by value, of the room the parent has left.
    grow,
    // value (0 to 1) of the parent's inner size.
    percent,
};

// How one axis of an element is sized, then clamped to [min, max]. Fit and grow elements whose
// content can wrap or cut (text, and boxes holding it) shrink below their content when their parent
// has too little room, never below min.
struct size_rule {
    size_kind kind = size_kind::fit;
    f32 value = 0.0F;
    f32 min = 0.0F;
    f32 max = std::numeric_limits<f32>::infinity();
};

constexpr auto fit() -> size_rule {
    return {.kind = size_kind::fit};
}

constexpr auto fixed(f32 size) -> size_rule {
    return {.kind = size_kind::fixed, .value = size};
}

constexpr auto grow() -> size_rule {
    return {.kind = size_kind::grow, .value = 1.0F};
}

constexpr auto percent(f32 fraction) -> size_rule {
    return {.kind = size_kind::percent, .value = fraction};
}

struct size_bounds {
    f32 min = 0.0F;
    f32 max = std::numeric_limits<f32>::infinity();
};

constexpr auto bounded(size_rule rule, size_bounds bounds) -> size_rule {
    rule.min = bounds.min;
    rule.max = bounds.max;
    return rule;
}

// Children are laid out along the main axis: x for a row, y for a column.
enum class direction : u8 {
    row,
    column,
};

enum class main_align : u8 {
    start,
    center,
    end,
    // Room left over goes between the children, none before the first or after the last.
    space_between,
};

enum class cross_align : u8 {
    start,
    center,
    end,
    // Children not sized fixed fill the cross axis.
    stretch,
};

struct edges {
    f32 left = 0.0F;
    f32 top = 0.0F;
    f32 right = 0.0F;
    f32 bottom = 0.0F;
};

constexpr auto even(f32 size) -> edges {
    return {.left = size, .top = size, .right = size, .bottom = size};
}

constexpr auto symmetric(f32 horizontal, f32 vertical) -> edges {
    return {.left = horizontal, .top = vertical, .right = horizontal, .bottom = vertical};
}

// A see-through surface: what is behind the box, blurred, under its fill and a grain.
struct glass_look {
    // The blur's standard deviation, in units.
    f32 blur = 0.0F;
    // A band this wide, in units, along the edge where the backdrop bends like light in a bevel.
    f32 rim = 0.0F;
    // Noise over the fill, at a random fraction of this colour's alpha per pixel.
    draw::color grain;
    // Set to have the backend report the light behind the box under this key.
    std::optional<draw::light_key> light;
};

// What a box draws under its children: shadow, glass, fill, then an outline inside its edge.
struct decoration {
    draw::paint fill = draw::solid(draw::transparent);
    f32 radius = 0.0F;
    draw::color outline = draw::transparent;
    f32 outline_width = 0.0F;
    std::optional<draw::shadow_style> shadow = std::nullopt;
    std::optional<glass_look> glass = std::nullopt;
};

// Nothing drawn: what a box has unless it says otherwise.
inline constexpr decoration undecorated{};

// Whether children that don't fit along the main axis start a new line. Rows only: a column's
// heights are settled after its widths, too late to break it into columns.
enum class line_break : u8 {
    none,
    // Lines are as tall as their tallest child, gap apart, aligned to the start; grow children
    // share out their own line's room.
    wrap,
};

enum class clipping : u8 {
    none,
    // Children are drawn and hit only inside the box.
    children,
};

// An element taken out of its parent's flow and set at a point of it. Points are fractions of a
// box, (0, 0) its top left and (1, 1) its bottom right; the parent's is its padded inner box.
// Pinned elements take no room from their siblings and add none to their parent's fit size.
struct pin {
    draw::vec2 parent_point;
    draw::vec2 own_point;
    // Added after, in units.
    draw::vec2 offset;
};

// At offset from the parent's inner top left.
constexpr auto absolute(draw::vec2 offset) -> pin {
    return {
        .parent_point = {.x = 0.0F, .y = 0.0F},
        .own_point = {.x = 0.0F, .y = 0.0F},
        .offset = offset,
    };
}

struct box_style {
    direction flow = direction::row;
    size_rule width;
    size_rule height;
    edges padding = even(0.0F);
    f32 gap = 0.0F;
    main_align main = main_align::start;
    cross_align cross = cross_align::start;
    decoration look = undecorated;
    line_break lines = line_break::none;
    clipping clip = clipping::none;
    std::optional<pin> pinned = std::nullopt;
};

}
