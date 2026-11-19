#include <lucent/ui/slider.hpp>

#include <algorithm>
#include <cmath>
#include <format>
#include <optional>
#include <string>

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
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {
namespace {

// What the track draws from, copied out of the frame it was declared in.
struct track_look {
    draw::color track;
    draw::color fill;
    draw::color thumb;
    draw::color ring;
    f32 thickness = 0.0F;
    f32 thumb_radius = 0.0F;
    f32 ring_width = 0.0F;
    f32 fraction = 0.0F;
};

auto draw_track(draw::draw_list& list, const draw::rect& area, const track_look& look) -> void {
    const f32 middle = (area.min.y + area.max.y) / 2.0F;
    const f32 start = area.min.x + look.thumb_radius;
    const f32 end = area.max.x - look.thumb_radius;
    const f32 thumb = start + ((end - start) * look.fraction);
    const auto bar = [&](f32 left, f32 right) {
        return draw::rounded_rect{
            .bounds =
                {
                    .min = {.x = left, .y = middle - (look.thickness / 2.0F)},
                    .max = {.x = right, .y = middle + (look.thickness / 2.0F)},
                },
            .radii = draw::uniform(look.thickness / 2.0F),
        };
    };
    list.fill(bar(start, end), draw::solid(look.track));
    list.fill(bar(start, thumb), draw::solid(look.fill));
    const draw::circle knob{.centre = {.x = thumb, .y = middle}, .radius = look.thumb_radius};
    list.fill(knob, draw::solid(look.thumb));
    if (look.ring.a > 0) {
        list.stroke(knob, draw::solid(look.ring), {.width = look.ring_width});
    }
}

auto fraction_of(const slider_spec& spec, f32 value) -> f32 {
    const f32 span = spec.max - spec.min;
    return span > 0.0F ? std::clamp((value - spec.min) / span, 0.0F, 1.0F) : 0.0F;
}

// As many decimals as the step has, so a step of 0.05 shows 0.35, not 0.350000.
auto shown(const slider_spec& spec, f32 value) -> std::string {
    const i32 decimals =
        spec.step > 0.0F && spec.step < 1.0F
            ? std::clamp(static_cast<i32>(std::ceil(-std::log10(spec.step) - 0.0001F)), 0, 6)
            : 0;
    return std::format("{:.{}f}", value, decimals);
}

auto keyed_value(const context& frame, const slider_spec& spec, f32 value) -> f32 {
    const input_snapshot& input = frame.input();
    const f32 nudge = spec.step > 0.0F ? spec.step : (spec.max - spec.min) / 100.0F;
    if (has_press(input, key_code::left)) {
        value = slider_value(spec, fraction_of(spec, value - nudge));
    }
    if (has_press(input, key_code::right)) {
        value = slider_value(spec, fraction_of(spec, value + nudge));
    }
    if (has_press(input, key_code::home)) {
        value = spec.min;
    }
    if (has_press(input, key_code::end)) {
        value = spec.max;
    }
    return value;
}

// Where the thumb's centre can go along a track.
struct thumb_travel {
    f32 start = 0.0F;
    f32 length = 0.0F;
};

auto travel_of(const draw::rect& track, f32 thumb_radius) -> thumb_travel {
    return {
        .start = track.min.x + thumb_radius,
        .length = track.max.x - track.min.x - (2.0F * thumb_radius),
    };
}

auto dragged_value(const slider_spec& spec, thumb_travel travel, f32 cursor) -> f32 {
    if (travel.length <= 0.0F) {
        return spec.value;
    }
    return slider_value(spec, (cursor - travel.start) / travel.length);
}

}

auto slider_value(const slider_spec& spec, f32 fraction) -> f32 {
    const f32 span = spec.max - spec.min;
    f32 offset = std::clamp(fraction, 0.0F, 1.0F) * span;
    if (spec.step > 0.0F) {
        offset = std::round(offset / spec.step) * spec.step;
    }
    return std::clamp(
        spec.min + offset, std::min(spec.min, spec.max), std::max(spec.min, spec.max)
    );
}

auto slider(context& frame, local_key key, const slider_spec& spec) -> std::optional<f32> {
    const theme& tokens = frame.tokens();
    std::optional<f32> changed;
    const box_style column{
        .flow = direction::column,
        .width = grow(),
        .height = fit(),
        .padding = symmetric(tokens.spacing.m, tokens.spacing.s),
        .gap = tokens.spacing.xs,
        .main = main_align::start,
        .cross = cross_align::stretch,
    };
    frame.box(key, column, [&] {
        const element_id track = frame.id_of(ui::key<"track">());
        const interaction hit = frame.interact(track, flags{sense::drag, sense::focus});
        f32 value = spec.value;
        if (hit.is_pressed && hit.rect && hit.cursor) {
            value = dragged_value(
                spec, travel_of(*hit.rect, tokens.controls.thumb_radius), hit.cursor->x
            );
        }
        if (hit.is_focused) {
            value = keyed_value(frame, spec, value);
        }
        if (value < spec.value || value > spec.value) {
            changed = value;
        }
        const std::string figure = shown(spec, value);
        frame.box(
            {
                .flow = direction::row,
                .width = grow(),
                .height = fit(),
                .gap = tokens.spacing.m,
                .main = main_align::space_between,
                .cross = cross_align::center,
            },
            [&] {
                frame.text({
                    .utf8 = spec.caption,
                    .style = tokens.type.body,
                    .ink = tokens.colors.ink,
                    .wrap = text::text_wrap::none,
                    .overflow = text::text_overflow::ellipsis,
                    .max_lines = 1,
                });
                frame.text({
                    .utf8 = figure,
                    .style = tokens.type.numeric,
                    .ink = tokens.colors.muted_ink,
                    .wrap = text::text_wrap::none,
                    .overflow = text::text_overflow::visible,
                    .max_lines = std::nullopt,
                });
            }
        );
        const track_look look{
            .track = tokens.colors.sunken,
            .fill = tokens.colors.accent,
            .thumb = tokens.colors.ink,
            .ring = hit.is_focused ? tokens.colors.focus : draw::transparent,
            .thickness = tokens.controls.track_thickness,
            .thumb_radius = tokens.controls.thumb_radius,
            .ring_width = tokens.controls.focus_width,
            .fraction = fraction_of(spec, value),
        };
        frame.custom(
            ui::key<"track">(),
            {
                .flow = direction::row,
                .width = grow(),
                .height = fixed(tokens.controls.thumb_radius * 2.0F),
                .gap = 0.0F,
                .main = main_align::start,
                .cross = cross_align::start,
            },
            [look](draw::draw_list& list, const draw::rect& area) { draw_track(list, area, look); }
        );
    });
    return changed;
}

}
