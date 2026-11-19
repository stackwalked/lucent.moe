#include "color_swatch.hpp"

#include <cmath>
#include <optional>
#include <string_view>

#include <lucent/core/flags.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/slider.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::menu::detail {
namespace {

auto as_draw(kit::color value) -> draw::color {
    return {.r = value.r, .g = value.g, .b = value.b, .a = value.a};
}

// A channel's slider; the channel as it stands after this frame.
auto channel(ui::context& frame, ui::local_key key, std::string_view caption, u8 value) -> u8 {
    const std::optional<f32> moved = ui::slider(
        frame,
        key,
        {
            .caption = caption,
            .value = static_cast<f32>(value),
            .min = 0.0F,
            .max = 255.0F,
            .step = 1.0F,
        }
    );
    if (!moved) {
        return value;
    }
    return narrow<u8>(static_cast<i32>(std::lround(*moved)));
}

auto channel_sliders(ui::context& frame, const color_swatch_spec& spec) -> kit::color {
    return {
        .r = channel(frame, ui::key<"red">(), spec.channels[0], spec.value.r),
        .g = channel(frame, ui::key<"green">(), spec.channels[1], spec.value.g),
        .b = channel(frame, ui::key<"blue">(), spec.channels[2], spec.value.b),
        .a = channel(frame, ui::key<"alpha">(), spec.channels[3], spec.value.a),
    };
}

}

auto color_swatch(ui::context& frame, ui::local_key key, const color_swatch_spec& spec)
    -> std::optional<kit::color> {
    const ui::theme& tokens = frame.tokens();
    const ui::interaction hit =
        frame.interact(frame.id_of(key), flags{ui::sense::click, ui::sense::focus});
    // A mouse opens and closes it on the press; a key's activation never holds the button.
    if (hit.is_just_pressed || (hit.is_activated && !hit.is_pressed)) {
        if (frame.is_popup_open(hit.id)) {
            frame.close_popup(hit.id);
        } else {
            frame.open_popup(hit.id);
        }
    }
    frame.box(
        key,
        {
            .flow = ui::direction::row,
            .width = ui::fixed(tokens.controls.toggle_width),
            .height = ui::fixed(tokens.controls.toggle_height),
            .gap = 0.0F,
            .main = ui::main_align::start,
            .cross = ui::cross_align::start,
            .look =
                {
                    .fill = draw::solid(as_draw(spec.value)),
                    .radius = tokens.radii.s,
                    .outline = hit.is_focused ? tokens.colors.focus : tokens.colors.muted_ink,
                    .outline_width = tokens.controls.focus_width,
                    .shadow = std::nullopt,
                },
        },
        [] {}
    );
    kit::color edited = spec.value;
    const ui::plate_material& plate = tokens.materials.plate;
    frame.popup(
        hit.id,
        {
            .flow = ui::direction::column,
            .width = ui::fixed(tokens.controls.toggle_width * 6.0F),
            .height = ui::fit(),
            .padding = ui::even(tokens.spacing.s),
            .gap = tokens.spacing.xs,
            .main = ui::main_align::start,
            .cross = ui::cross_align::stretch,
            .look =
                {
                    .fill = draw::solid(plate.fill),
                    .radius = tokens.radii.m,
                    .outline = plate.rim,
                    .outline_width = plate.rim_width,
                    .shadow = plate.shadow,
                },
        },
        [&] { edited = channel_sliders(frame, spec); }
    );
    if (edited == spec.value) {
        return std::nullopt;
    }
    return edited;
}

}
