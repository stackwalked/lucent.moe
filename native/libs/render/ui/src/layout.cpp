#include "layout.hpp"

#include <algorithm>
#include <cmath>
#include <optional>
#include <ranges>
#include <string_view>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>

#include "element.hpp"

namespace lucent::ui::detail {
namespace {

// Room smaller than this is no room: what float sums leave behind.
constexpr f32 slack_epsilon = 0.001F;

auto rule_of(const box_style& style, axis along) -> const size_rule& {
    return along == axis::x ? style.width : style.height;
}

auto main_axis(const box_style& style) -> axis {
    return style.flow == direction::row ? axis::x : axis::y;
}

auto leading(const edges& padding, axis along) -> f32 {
    return along == axis::x ? padding.left : padding.top;
}

auto padding_along(const edges& padding, axis along) -> f32 {
    return along == axis::x ? padding.left + padding.right : padding.top + padding.bottom;
}

auto component(draw::vec2 point, axis along) -> f32 {
    return along == axis::x ? point.x : point.y;
}

auto clamped(f32 size, const size_rule& rule) -> f32 {
    return std::max(rule.min, std::min(size, rule.max));
}

auto gaps(const element& parent) -> f32 {
    return parent.child_count > 1 ? parent.style.gap * static_cast<f32>(parent.child_count - 1)
                                  : 0.0F;
}

auto is_shrinkable(const text_leaf& leaf) -> bool {
    return leaf.wrap == text::text_wrap::words || leaf.overflow == text::text_overflow::ellipsis;
}

auto request_for(const text_leaf& leaf, const layout_frame& frame, f32 max_width)
    -> text::layout_request {
    return {
        .utf8 = frame.strings.substr(narrow<usize>(leaf.begin), narrow<usize>(leaf.size)),
        .style = leaf.style,
        .max_width = std::isfinite(max_width) ? std::max(max_width, 0.0F) : 0.0F,
        .wrap = leaf.wrap,
        .overflow = leaf.overflow,
        .max_lines = leaf.max_lines,
        .pixels_per_unit = frame.pixels_per_unit,
    };
}

auto measure_text(
    std::vector<element>& elements, text::text_system& text, const layout_frame& frame
) -> result<void> {
    for (element& declared : elements) {
        const result<void> measured = match(
            declared.content,
            [&](text_leaf& leaf) -> result<void> {
                text::layout_request natural = request_for(leaf, frame, 0.0F);
                natural.wrap = text::text_wrap::none;
                natural.overflow = text::text_overflow::visible;
                natural.max_lines = std::nullopt;
                const text::text_layout* const laid_out = LUCENT_TRY(text.layout(natural));
                leaf.natural_width = laid_out->size.x;
                leaf.laid_out = laid_out;
                return {};
            },
            [](auto&) -> result<void> { return {}; }
        );
        LUCENT_TRY(measured);
    }
    return {};
}

auto wrap_text(std::vector<element>& elements, text::text_system& text, const layout_frame& frame)
    -> result<void> {
    for (element& declared : elements) {
        const f32 width = declared.size[x_axis] - padding_along(declared.style.padding, axis::x);
        const result<void> wrapped = match(
            declared.content,
            [&](text_leaf& leaf) -> result<void> {
                if (!is_shrinkable(leaf)) {
                    return {};
                }
                leaf.laid_out = LUCENT_TRY(text.layout(request_for(leaf, frame, width)));
                return {};
            },
            [](auto&) -> result<void> { return {}; }
        );
        LUCENT_TRY(wrapped);
    }
    return {};
}

struct intrinsic {
    f32 size = 0.0F;
    f32 floor = 0.0F;
};

auto intrinsic_of(const element& declared, axis along, f32 pixels_per_unit) -> intrinsic {
    return match(
        declared.content,
        [&](const text_leaf& leaf) -> intrinsic {
            if (along == axis::y) {
                const f32 height = leaf.laid_out == nullptr ? 0.0F : leaf.laid_out->size.y;
                return {.size = height, .floor = height};
            }
            return {
                .size = leaf.natural_width,
                .floor = is_shrinkable(leaf) ? 0.0F : leaf.natural_width,
            };
        },
        [&](const icon_leaf& leaf) -> intrinsic {
            const i32 pixels = along == axis::x ? leaf.drawn.size.width : leaf.drawn.size.height;
            const f32 size = static_cast<f32>(pixels) / pixels_per_unit;
            return {.size = size, .floor = size};
        },
        [](const auto&) -> intrinsic { return {}; }
    );
}

// Bottom-up: every element's content and its size before its parent has a say.
auto fit_sizes(std::vector<element>& elements, axis along, f32 pixels_per_unit) -> void {
    for (element& declared : std::views::reverse(elements)) {
        const bool is_main = along == main_axis(declared.style);
        intrinsic inner = intrinsic_of(declared, along, pixels_per_unit);
        for (isize child = declared.first_child; child != -1;
            child = elements.at(narrow<usize>(child)).next_sibling) {
            const element& placed = elements.at(narrow<usize>(child));
            const size_rule& rule = rule_of(placed.style, along);
            const f32 size =
                rule.kind == size_kind::percent ? rule.min : placed.size.at(index_of(along));
            const f32 floor = placed.floor.at(index_of(along));
            inner.size = is_main ? inner.size + size : std::max(inner.size, size);
            inner.floor = is_main ? inner.floor + floor : std::max(inner.floor, floor);
        }
        const f32 padding =
            padding_along(declared.style.padding, along) + (is_main ? gaps(declared) : 0.0F);
        const size_rule& rule = rule_of(declared.style, along);
        declared.extent.at(index_of(along)) = inner.size + padding;
        switch (rule.kind) {
        case size_kind::fixed:
            declared.size.at(index_of(along)) = clamped(rule.value, rule);
            declared.floor.at(index_of(along)) = declared.size.at(index_of(along));
            break;
        case size_kind::fit:
        case size_kind::grow:
            declared.size.at(index_of(along)) = clamped(inner.size + padding, rule);
            declared.floor.at(index_of(along)) =
                std::min(declared.size.at(index_of(along)), clamped(inner.floor + padding, rule));
            break;
        case size_kind::percent:
            declared.size.at(index_of(along)) = rule.min;
            declared.floor.at(index_of(along)) = rule.min;
            break;
        }
        if (declared.is_scroll && along == axis::y) {
            declared.floor.at(index_of(along)) = rule.min;
        }
    }
}

auto size_root(element& root, const root_entry& entry, axis along, const layout_frame& frame)
    -> void {
    const size_rule& rule = rule_of(root.style, along);
    const f32 viewport = component(frame.viewport, along);
    switch (rule.kind) {
    case size_kind::fixed:
    case size_kind::fit:
        break;
    case size_kind::grow:
        root.size.at(index_of(along)) = clamped(viewport - component(entry.position, along), rule);
        break;
    case size_kind::percent:
        root.size.at(index_of(along)) = clamped(viewport * rule.value, rule);
        break;
    }
}

// Rounds of handing out room: each round either places all of it or pins one more child at its
// max, so as many rounds as children always finish.
auto grow_children(std::vector<element>& elements, const element& parent, axis along, f32 room)
    -> void {
    for (isize round = 0; round < parent.child_count && room > slack_epsilon; ++round) {
        f32 weights = 0.0F;
        for (isize child = parent.first_child; child != -1;
            child = elements.at(narrow<usize>(child)).next_sibling) {
            const element& placed = elements.at(narrow<usize>(child));
            const size_rule& rule = rule_of(placed.style, along);
            if (rule.kind == size_kind::grow && placed.size.at(index_of(along)) < rule.max) {
                weights += std::max(rule.value, 0.0F);
            }
        }
        if (weights <= 0.0F) {
            return;
        }
        f32 placed_room = 0.0F;
        for (isize child = parent.first_child; child != -1;
            child = elements.at(narrow<usize>(child)).next_sibling) {
            element& placed = elements.at(narrow<usize>(child));
            const size_rule& rule = rule_of(placed.style, along);
            if (rule.kind != size_kind::grow || placed.size.at(index_of(along)) >= rule.max) {
                continue;
            }
            const f32 before = placed.size.at(index_of(along));
            placed.size.at(index_of(along)) =
                clamped(before + (room * std::max(rule.value, 0.0F) / weights), rule);
            placed_room += placed.size.at(index_of(along)) - before;
        }
        room -= placed_room;
    }
}

// Takes from each child in proportion to how far it is above its floor, so text shrinks before
// anything rigid and nothing passes its floor.
auto shrink_children(std::vector<element>& elements, const element& parent, axis along, f32 excess)
    -> void {
    f32 shrinkable = 0.0F;
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        const element& placed = elements.at(narrow<usize>(child));
        shrinkable +=
            std::max(placed.size.at(index_of(along)) - placed.floor.at(index_of(along)), 0.0F);
    }
    if (shrinkable <= 0.0F) {
        return;
    }
    const f32 taken = std::min(excess, shrinkable);
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        element& placed = elements.at(narrow<usize>(child));
        const f32 above =
            std::max(placed.size.at(index_of(along)) - placed.floor.at(index_of(along)), 0.0F);
        placed.size.at(index_of(along)) -= taken * above / shrinkable;
    }
}

auto size_main_children(std::vector<element>& elements, const element& parent, axis along) -> void {
    const f32 inner = parent.size.at(index_of(along)) - padding_along(parent.style.padding, along);
    f32 used = gaps(parent);
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        element& placed = elements.at(narrow<usize>(child));
        const size_rule& rule = rule_of(placed.style, along);
        if (rule.kind == size_kind::percent) {
            placed.size.at(index_of(along)) = clamped(inner * rule.value, rule);
        }
        used += placed.size.at(index_of(along));
    }
    // A scroll's content runs on past it.
    if (parent.is_scroll && along == axis::y) {
        return;
    }
    const f32 room = inner - used;
    if (room > slack_epsilon) {
        grow_children(elements, parent, along, room);
    } else if (room < -slack_epsilon) {
        shrink_children(elements, parent, along, -room);
    }
}

auto size_cross_children(std::vector<element>& elements, const element& parent, axis along)
    -> void {
    const f32 inner = parent.size.at(index_of(along)) - padding_along(parent.style.padding, along);
    const bool is_unbounded = parent.is_scroll && along == axis::y;
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        element& placed = elements.at(narrow<usize>(child));
        const size_rule& rule = rule_of(placed.style, along);
        switch (rule.kind) {
        case size_kind::fixed:
            break;
        case size_kind::percent:
            placed.size.at(index_of(along)) = clamped(inner * rule.value, rule);
            break;
        case size_kind::grow:
            placed.size.at(index_of(along)) = clamped(inner, rule);
            break;
        case size_kind::fit:
            if (parent.style.cross == cross_align::stretch) {
                placed.size.at(index_of(along)) = clamped(inner, rule);
            } else if (placed.size.at(index_of(along)) > inner && !is_unbounded) {
                placed.size.at(index_of(along)) =
                    std::max(placed.floor.at(index_of(along)), clamped(inner, rule));
            }
            break;
        }
    }
}

auto anchor_of(const std::vector<element>& elements, const root_entry& entry)
    -> std::optional<draw::rect> {
    if (entry.anchor_element) {
        return rect_of(elements.at(narrow<usize>(*entry.anchor_element)));
    }
    return entry.anchor_rect;
}

// Top-down: each element, its size final, settles its children's. A popup is at least as wide as
// its anchor, which was declared, so sized, before it.
auto final_sizes(std::vector<element>& elements, axis along, const layout_frame& frame) -> void {
    for (isize index = 0; index < std::ssize(elements); ++index) {
        element& declared = elements.at(narrow<usize>(index));
        if (declared.parent == -1) {
            const root_entry& entry = frame.roots->at(narrow<usize>(declared.root));
            size_root(declared, entry, along, frame);
            const std::optional<draw::rect> anchor = anchor_of(elements, entry);
            if (entry.layer == root_layer::popup && along == axis::x && anchor) {
                declared.size[x_axis] =
                    std::max(declared.size[x_axis], anchor->max.x - anchor->min.x);
            }
        }
        if (along == main_axis(declared.style)) {
            size_main_children(elements, declared, along);
        } else {
            size_cross_children(elements, declared, along);
        }
    }
}

auto popup_position(
    const std::vector<element>& elements,
    const root_entry& entry,
    const element& root,
    const layout_frame& frame
) -> draw::vec2 {
    const std::optional<draw::rect> anchor = anchor_of(elements, entry);
    if (!anchor) {
        return entry.position;
    }
    const f32 height = root.size[y_axis];
    const f32 below = anchor->max.y + frame.popup_gap;
    const f32 above = anchor->min.y - frame.popup_gap - height;
    const bool is_flipped = below + height > frame.viewport.y && above >= 0.0F;
    return {.x = anchor->min.x, .y = is_flipped ? above : below};
}

auto place_root(std::vector<element>& elements, isize index, const layout_frame& frame) -> void {
    element& root = elements.at(narrow<usize>(index));
    const root_entry& entry = frame.roots->at(narrow<usize>(root.root));
    const draw::vec2 origin = entry.layer == root_layer::popup
                                  ? popup_position(elements, entry, root, frame)
                                  : entry.position;
    root.position = {origin.x, origin.y};
    root.clip = {.min = {.x = 0.0F, .y = 0.0F}, .max = frame.viewport};
}

auto main_start(const element& parent, f32 room) -> f32 {
    switch (parent.style.main) {
    case main_align::start:
    case main_align::space_between:
        return 0.0F;
    case main_align::center:
        return room / 2.0F;
    case main_align::end:
        return room;
    }
    LUCENT_UNREACHABLE();
}

auto cross_offset(cross_align align, f32 room) -> f32 {
    switch (align) {
    case cross_align::start:
    case cross_align::stretch:
        return 0.0F;
    case cross_align::center:
        return room / 2.0F;
    case cross_align::end:
        return room;
    }
    LUCENT_UNREACHABLE();
}

auto place_children(std::vector<element>& elements, const element& parent) -> void {
    const axis main = main_axis(parent.style);
    const axis cross = main == axis::x ? axis::y : axis::x;
    f32 used = gaps(parent);
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        used += elements.at(narrow<usize>(child)).size.at(index_of(main));
    }
    const f32 inner_main =
        parent.size.at(index_of(main)) - padding_along(parent.style.padding, main);
    const f32 inner_cross =
        parent.size.at(index_of(cross)) - padding_along(parent.style.padding, cross);
    const f32 room = std::max(inner_main - used, 0.0F);
    const f32 gap = parent.style.main == main_align::space_between && parent.child_count > 1
                        ? parent.style.gap + (room / static_cast<f32>(parent.child_count - 1))
                        : parent.style.gap;
    const draw::rect clip =
        parent.is_scroll ? intersect(parent.clip, rect_of(parent)) : parent.clip;
    f32 pen = parent.position.at(index_of(main)) + leading(parent.style.padding, main)
              + main_start(parent, room);
    for (isize child = parent.first_child; child != -1;
        child = elements.at(narrow<usize>(child)).next_sibling) {
        element& placed = elements.at(narrow<usize>(child));
        placed.position.at(index_of(main)) = pen;
        pen += placed.size.at(index_of(main)) + gap;
        placed.position.at(index_of(cross)) =
            parent.position.at(index_of(cross)) + leading(parent.style.padding, cross)
            + cross_offset(parent.style.cross, inner_cross - placed.size.at(index_of(cross)));
        if (parent.is_scroll) {
            placed.position[y_axis] -= parent.scroll_offset;
        }
        placed.clip = clip;
    }
}

auto place(std::vector<element>& elements, const layout_frame& frame) -> void {
    for (isize index = 0; index < std::ssize(elements); ++index) {
        if (elements.at(narrow<usize>(index)).parent == -1) {
            place_root(elements, index, frame);
        }
        place_children(elements, elements.at(narrow<usize>(index)));
    }
}

}

auto lay_out(std::vector<element>& elements, text::text_system& text, const layout_frame& frame)
    -> result<void> {
    LUCENT_INVARIANT(frame.roots != nullptr);
    LUCENT_TRY(measure_text(elements, text, frame));
    fit_sizes(elements, axis::x, frame.pixels_per_unit);
    final_sizes(elements, axis::x, frame);
    LUCENT_TRY(wrap_text(elements, text, frame));
    fit_sizes(elements, axis::y, frame.pixels_per_unit);
    final_sizes(elements, axis::y, frame);
    place(elements, frame);
    return {};
}

}
