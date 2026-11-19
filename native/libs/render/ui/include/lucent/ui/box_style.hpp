#pragma once

#include <limits>
#include <optional>

#include <lucent/draw/color.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/shadow_style.hpp>

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

// What a box draws under its children: shadow, fill, then an outline inside its edge.
struct decoration {
    draw::paint fill = draw::solid(draw::transparent);
    f32 radius = 0.0F;
    draw::color outline = draw::transparent;
    f32 outline_width = 0.0F;
    std::optional<draw::shadow_style> shadow = std::nullopt;
};

// Nothing drawn: what a box has unless it says otherwise.
inline constexpr decoration undecorated{};

struct box_style {
    direction flow = direction::row;
    size_rule width;
    size_rule height;
    edges padding = even(0.0F);
    f32 gap = 0.0F;
    main_align main = main_align::start;
    cross_align cross = cross_align::start;
    decoration look = undecorated;
};

}
