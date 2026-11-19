#include <lucent/cs2-features/player_box.hpp>

#include <algorithm>
#include <array>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <lucent/cs2-domains/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/segment.hpp>
#include <lucent/draw/stroke_style.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/canvas.hpp>
#include <lucent/kit/draw_context.hpp>

#include "lucent/kit/settings.hpp"

namespace lucent::cs2::features {
namespace {

// Between a box's top and its name's bottom, in units.
constexpr f32 name_gap = 3.0F;
constexpr f32 name_size = 13.0F;
// A dark edge on both sides of the stroke, so a box reads on any background.
constexpr f32 outline = 1.0F;
constexpr draw::color outline_tint{.r = 0, .g = 0, .b = 0, .a = 160};

auto to_draw(kit::color chosen) -> draw::color {
    return {.r = chosen.r, .g = chosen.g, .b = chosen.b, .a = chosen.a};
}

auto tint_of(const player& seen, const player_box_settings& chosen) -> draw::color {
    if (chosen.coloring == box_coloring::single) {
        return to_draw(chosen.single);
    }
    switch (seen.side) {
    case team::terrorists:
        return to_draw(chosen.terrorists);
    case team::counter_terrorists:
        return to_draw(chosen.counter_terrorists);
    case team::none:
        return to_draw(chosen.single);
    }
    return to_draw(chosen.single);
}

auto corners_of(const player& seen) -> std::array<vec3, 8> {
    const vec3 low{
        .x = seen.origin.x + seen.mins.x,
        .y = seen.origin.y + seen.mins.y,
        .z = seen.origin.z + seen.mins.z,
    };
    const vec3 high{
        .x = seen.origin.x + seen.maxs.x,
        .y = seen.origin.y + seen.maxs.y,
        .z = seen.origin.z + seen.maxs.z,
    };
    return {
        vec3{.x = low.x, .y = low.y, .z = low.z},
        vec3{.x = high.x, .y = low.y, .z = low.z},
        vec3{.x = low.x, .y = high.y, .z = low.z},
        vec3{.x = high.x, .y = high.y, .z = low.z},
        vec3{.x = low.x, .y = low.y, .z = high.z},
        vec3{.x = high.x, .y = low.y, .z = high.z},
        vec3{.x = low.x, .y = high.y, .z = high.z},
        vec3{.x = high.x, .y = high.y, .z = high.z},
    };
}

// The screen box around every corner, or none when a corner is behind the camera.
auto screen_box_of(const player& seen, const view& camera, draw::vec2 screen)
    -> std::optional<draw::rect> {
    const std::array<vec3, 8> corners = corners_of(seen);
    const std::optional<draw::vec2> first = project(camera, corners.front(), screen);
    if (!first) {
        return std::nullopt;
    }
    draw::rect box{.min = *first, .max = *first};
    for (const vec3 corner : corners) {
        const std::optional<draw::vec2> point = project(camera, corner, screen);
        if (!point) {
            return std::nullopt;
        }
        box.min = {.x = std::min(box.min.x, point->x), .y = std::min(box.min.y, point->y)};
        box.max = {.x = std::max(box.max.x, point->x), .y = std::max(box.max.y, point->y)};
    }
    return box;
}

auto is_drawn(const player& seen) -> bool {
    return seen.is_alive && !seen.is_local;
}

auto is_on_screen(const draw::rect& box, draw::vec2 screen) -> bool {
    const draw::rect whole{
        .min = {.x = 0.0F, .y = 0.0F},
        .max = screen,
    };
    return !draw::is_empty(draw::intersect(box, whole));
}

auto grown(const draw::rect& box, f32 margin) -> draw::rect {
    return {
        .min = box.min - draw::vec2{.x = margin, .y = margin},
        .max = box.max + draw::vec2{.x = margin, .y = margin},
    };
}

}

auto marks_of(const kit::draw_context<player_box>& parts) -> std::vector<player_mark> {
    const auto& players = parts.view<world>();
    const auto& camera = parts.view<view>();
    const player_box_settings& chosen = parts.settings();
    const draw::vec2 screen = parts.onto().viewport();
    std::vector<player_mark> marks;
    for (const player& seen : players.players) {
        if (!is_drawn(seen)) {
            continue;
        }
        const std::optional<draw::rect> box = screen_box_of(seen, camera, screen);
        if (!box || !is_on_screen(*box, screen)) {
            continue;
        }
        marks.push_back(
            player_mark{
                .box = *box,
                .tint = tint_of(seen, chosen),
                .name = chosen.should_show_names ? seen.name : std::string{},
                .name_anchor = {.x = (box->min.x + box->max.x) / 2.0F, .y = box->min.y - name_gap},
            }
        );
    }
    return marks;
}

auto player_box::draw(const kit::draw_context<player_box>& parts) -> void {
    const f32 thickness = parts.settings().thickness;
    kit::canvas& onto = parts.onto();
    for (player_mark& mark : marks_of(parts)) {
        const draw::rounded_rect edge{.bounds = grown(mark.box, outline), .radii = {}};
        onto.list().stroke(
            edge,
            draw::solid(outline_tint),
            draw::stroke_style{.width = thickness + (2.0F * outline), .ends = draw::cap::butt}
        );
        const draw::rounded_rect line{.bounds = mark.box, .radii = {}};
        onto.list().stroke(
            line,
            draw::solid(mark.tint),
            draw::stroke_style{.width = thickness, .ends = draw::cap::butt}
        );
        if (mark.name.empty()) {
            continue;
        }
        onto.add(
            kit::label{
                .text = std::move(mark.name),
                .anchor = mark.name_anchor,
                .size = name_size,
                .tint = mark.tint,
            }
        );
    }
}

}
