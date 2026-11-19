#include "record.hpp"

#include <algorithm>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/box_style.hpp>

#include "element.hpp"

namespace lucent::ui::detail {
namespace {

struct open_scroll {
    isize element = 0;
    isize end = 0;
};

auto decorate(draw::draw_list& list, const draw::rect& area, const decoration& look) -> void {
    const draw::rounded_rect shape{.bounds = area, .radii = draw::uniform(look.radius)};
    if (look.shadow) {
        list.shadow(shape, *look.shadow);
    }
    if (!draw::is_invisible(look.fill)) {
        list.fill(shape, look.fill);
    }
    if (look.outline_width > 0.0F && look.outline.a > 0) {
        list.stroke(shape, draw::solid(look.outline), {.width = look.outline_width});
    }
}

auto draw_leaf(
    draw::draw_list& list, text::text_system& text, const element& drawn, const record_input& input
) -> result<void> {
    const draw::vec2 origin{
        .x = drawn.position[x_axis] + drawn.style.padding.left,
        .y = drawn.position[y_axis] + drawn.style.padding.top,
    };
    return match(
        drawn.content,
        [](const no_leaf&) -> result<void> { return {}; },
        [&](const text_leaf& leaf) -> result<void> {
            if (leaf.laid_out == nullptr) {
                return {};
            }
            return text.draw(list, *leaf.laid_out, origin, leaf.ink);
        },
        [&](const icon_leaf& leaf) -> result<void> {
            text.draw(list, leaf.drawn, origin, leaf.tint);
            return {};
        },
        [&](const custom_leaf& leaf) -> result<void> {
            input.drawers->at(narrow<usize>(leaf.drawer))(list, rect_of(drawn));
            return {};
        }
    );
}

// A thumb along the right edge, sized and placed as the viewport is in the content.
auto draw_rail(draw::draw_list& list, const element& scroll, const record_input& input) -> void {
    const f32 content = scroll.extent[y_axis];
    const f32 viewport = scroll.size[y_axis];
    if (content <= viewport || content <= 0.0F) {
        return;
    }
    const draw::rect area = rect_of(scroll);
    const f32 length = std::max(viewport * viewport / content, input.rail_width * 2.0F);
    const f32 travel = viewport - length;
    const f32 reach = std::clamp(scroll.scroll_offset / (content - viewport), 0.0F, 1.0F);
    const f32 top = area.min.y + (travel * reach);
    list.fill(
        draw::rounded_rect{
            .bounds =
                {
                    .min = {.x = area.max.x - input.rail_width, .y = top},
                    .max = {.x = area.max.x, .y = top + length},
                },
            .radii = draw::uniform(input.rail_width / 2.0F),
        },
        draw::solid(input.rail)
    );
}

auto record_root(
    draw::draw_list& list, text::text_system& text, const record_input& input, isize root
) -> result<void> {
    const element& top = input.elements->at(narrow<usize>(root));
    std::vector<open_scroll> scrolls;
    // One past the subtree's end too, so every scroll still open closes there.
    for (isize index = root; index <= top.end; ++index) {
        while (!scrolls.empty() && index >= scrolls.back().end) {
            const isize closed = scrolls.back().element;
            scrolls.pop_back();
            list.pop_clip();
            draw_rail(list, input.elements->at(narrow<usize>(closed)), input);
        }
        if (index == top.end) {
            break;
        }
        const element& drawn = input.elements->at(narrow<usize>(index));
        if (drawn.root != top.root) {
            continue;
        }
        const draw::rect area = rect_of(drawn);
        if (!draw::is_empty(draw::intersect(area, drawn.clip))) {
            decorate(list, area, drawn.style.look);
            LUCENT_TRY(draw_leaf(list, text, drawn, input));
        }
        if (drawn.is_scroll) {
            list.push_clip(area);
            scrolls.push_back({.element = index, .end = drawn.end});
        }
    }
    return {};
}

}

auto record_roots(draw::draw_list& list, text::text_system& text, const record_input& input)
    -> result<void> {
    LUCENT_INVARIANT(
        input.elements != nullptr && input.order != nullptr && input.drawers != nullptr
    );
    for (const isize root : *input.order) {
        LUCENT_TRY(record_root(list, text, input, root));
    }
    return {};
}

}
