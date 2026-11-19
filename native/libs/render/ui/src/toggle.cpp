#include <lucent/ui/toggle.hpp>

#include <optional>

#include <lucent/core/flags.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

#include "control_look.hpp"

namespace lucent::ui {
namespace {

// What the switch draws from, copied out of the frame it was declared in.
struct switch_look {
    draw::color track;
    draw::color knob;
    f32 inset = 0.0F;
    // 0 off, 1 on: where the knob sits.
    f32 reach = 0.0F;
};

auto draw_switch(draw::draw_list& list, const draw::rect& area, const switch_look& look) -> void {
    const f32 height = area.max.y - area.min.y;
    list.fill(
        draw::rounded_rect{.bounds = area, .radii = draw::uniform(height / 2.0F)},
        draw::solid(look.track)
    );
    const f32 radius = (height / 2.0F) - look.inset;
    const f32 travel = (area.max.x - area.min.x) - height;
    list.fill(
        draw::circle{
            .centre =
                {
                    .x = area.min.x + (height / 2.0F) + (travel * look.reach),
                    .y = area.min.y + (height / 2.0F),
                },
            .radius = radius,
        },
        draw::solid(look.knob)
    );
}

}

auto toggle(context& frame, local_key key, const toggle_spec& spec) -> std::optional<bool> {
    const theme& tokens = frame.tokens();
    const interaction hit = frame.interact(frame.id_of(key), flags{sense::click, sense::focus});
    const bool is_on = hit.is_activated ? !spec.is_on : spec.is_on;
    const f32 reach = frame.spring(child_id(hit.id, ui::key<"knob">()), is_on ? 1.0F : 0.0F);
    const switch_look look{
        .track = composite(tokens.colors.sunken, tokens.colors.accent, reach),
        .knob = tokens.colors.ink,
        .inset = tokens.controls.knob_inset,
        .reach = reach,
    };
    const box_style row{
        .flow = direction::row,
        .width = grow(),
        .height = fixed(tokens.controls.height),
        .padding = symmetric(tokens.spacing.m, 0.0F),
        .gap = tokens.spacing.m,
        .main = main_align::space_between,
        .cross = cross_align::center,
        .look = {
            .fill = draw::solid(composite(
                draw::with_alpha(tokens.colors.raised, 0),
                tokens.colors.state_layer,
                detail::state_strength(frame, hit)
            )),
            .radius = tokens.radii.m,
            .outline = hit.is_focused ? tokens.colors.focus : draw::transparent,
            .outline_width = tokens.controls.focus_width,
            .shadow = std::nullopt,
        },
    };
    frame.box(key, row, [&] {
        frame.text({
            .utf8 = spec.caption,
            .style = tokens.type.body,
            .ink = tokens.colors.ink,
            .wrap = text::text_wrap::none,
            .overflow = text::text_overflow::ellipsis,
            .max_lines = 1,
        });
        frame.custom(
            ui::key<"switch">(),
            {
                .flow = direction::row,
                .width = fixed(tokens.controls.toggle_width),
                .height = fixed(tokens.controls.toggle_height),
                .gap = 0.0F,
                .main = main_align::start,
                .cross = cross_align::start,
            },
            [look](draw::draw_list& list, const draw::rect& area) { draw_switch(list, area, look); }
        );
    });
    if (is_on == spec.is_on) {
        return std::nullopt;
    }
    return is_on;
}

}
