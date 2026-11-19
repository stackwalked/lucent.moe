#pragma once

#include <lucent/draw/color.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui::detail {

// How strongly the state layer covers a control, eased per id so hover fades in and out.
inline auto state_strength(context& frame, const interaction& hit) -> f32 {
    const theme& tokens = frame.tokens();
    f32 wanted = 0.0F;
    if (hit.is_pressed) {
        wanted = 1.0F;
    } else if (hit.is_hovered) {
        wanted = tokens.controls.hover_strength;
    }
    return frame.approach(child_id(hit.id, key<"state">()), wanted);
}

// A raised control's fill with its state layer over it, and the focus ring when it has focus.
inline auto control_look(context& frame, const interaction& hit) -> decoration {
    const theme& tokens = frame.tokens();
    return {
        .fill = draw::solid(
            composite(tokens.colors.raised, tokens.colors.state_layer, state_strength(frame, hit))
        ),
        .radius = tokens.radii.m,
        .outline = hit.is_focused ? tokens.colors.focus : draw::transparent,
        .outline_width = tokens.controls.focus_width,
        .shadow = std::nullopt,
    };
}

}
