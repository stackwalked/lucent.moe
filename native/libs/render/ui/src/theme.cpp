#include <lucent/ui/theme.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>

#include <lucent/draw/color.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/ui/motion.hpp>

namespace lucent::ui {
namespace {

// What a preset fixes; the accent and scale fill in the rest.
struct palette {
    draw::color surface;
    draw::color raised;
    draw::color sunken;
    draw::color ink;
    draw::color muted_ink;
    draw::color danger;
    draw::color state_layer;
    draw::color rim;
    draw::color shade;
};

auto palette_of(theme_preset preset) -> palette {
    switch (preset) {
    case theme_preset::dark:
        return {
            .surface = {.r = 22, .g = 23, .b = 28, .a = 240},
            .raised = {.r = 36, .g = 38, .b = 46, .a = 255},
            .sunken = {.r = 12, .g = 13, .b = 16, .a = 255},
            .ink = {.r = 236, .g = 237, .b = 242, .a = 255},
            .muted_ink = {.r = 150, .g = 154, .b = 168, .a = 255},
            .danger = {.r = 238, .g = 84, .b = 84, .a = 255},
            .state_layer = {.r = 255, .g = 255, .b = 255, .a = 28},
            .rim = {.r = 255, .g = 255, .b = 255, .a = 20},
            .shade = {.r = 0, .g = 0, .b = 0, .a = 140},
        };
    case theme_preset::light:
        return {
            .surface = {.r = 246, .g = 246, .b = 249, .a = 245},
            .raised = {.r = 255, .g = 255, .b = 255, .a = 255},
            .sunken = {.r = 222, .g = 223, .b = 230, .a = 255},
            .ink = {.r = 22, .g = 23, .b = 28, .a = 255},
            .muted_ink = {.r = 98, .g = 102, .b = 116, .a = 255},
            .danger = {.r = 200, .g = 40, .b = 40, .a = 255},
            .state_layer = {.r = 0, .g = 0, .b = 0, .a = 20},
            .rim = {.r = 0, .g = 0, .b = 0, .a = 24},
            .shade = {.r = 0, .g = 0, .b = 0, .a = 70},
        };
    }
    LUCENT_UNREACHABLE();
}

auto channel(u8 base, u8 target, f32 amount) -> u8 {
    const f32 mixed =
        static_cast<f32>(base) + ((static_cast<f32>(target) - static_cast<f32>(base)) * amount);
    return static_cast<u8>(std::clamp(std::round(mixed), 0.0F, 255.0F));
}

auto mix(draw::color base, draw::color target, f32 amount) -> draw::color {
    return {
        .r = channel(base.r, target.r, amount),
        .g = channel(base.g, target.g, amount),
        .b = channel(base.b, target.b, amount),
        .a = channel(base.a, target.a, amount),
    };
}

// Rec. 709 weights on the sRGB values: rough, but only used to pick black or white ink.
auto lightness(draw::color tint) -> f32 {
    return ((0.2126F * static_cast<f32>(tint.r)) + (0.7152F * static_cast<f32>(tint.g))
               + (0.0722F * static_cast<f32>(tint.b)))
           / 255.0F;
}

auto shadow(draw::color shade, f32 blur, f32 drop) -> draw::shadow_style {
    return {.tint = shade, .blur = blur, .spread = 0.0F, .offset = {.x = 0.0F, .y = drop}};
}

auto timed(std::chrono::milliseconds duration, const theme_inputs& inputs)
    -> std::chrono::milliseconds {
    return inputs.is_reduced_motion ? std::chrono::milliseconds{0} : duration;
}

}

auto derive_theme(const theme_inputs& inputs) -> theme {
    const palette base = palette_of(inputs.preset);
    const f32 unit = std::max(inputs.scale, 0.25F);
    const draw::color accent = draw::with_alpha(inputs.accent, 255);
    const draw::color white = draw::white;
    const draw::color black{.r = 0, .g = 0, .b = 0, .a = 255};
    const draw::shadow_style high = shadow(base.shade, 18.0F * unit, 6.0F * unit);
    return {
        .colors =
            {
                .surface = base.surface,
                .raised = base.raised,
                .sunken = base.sunken,
                .ink = base.ink,
                .muted_ink = base.muted_ink,
                .accent = accent,
                .accent_ink = lightness(accent) > 0.6F ? black : white,
                .danger = base.danger,
                .focus = mix(accent, inputs.preset == theme_preset::dark ? white : black, 0.25F),
                .state_layer = base.state_layer,
            },
        .spacing =
            {
                .xs = 2.0F * unit,
                .s = 4.0F * unit,
                .m = 8.0F * unit,
                .l = 12.0F * unit,
                .xl = 20.0F * unit,
            },
        .radii = {.s = 4.0F * unit, .m = 8.0F * unit, .l = 12.0F * unit},
        .type =
            {
                .body = {.face = inputs.text_face, .size = 14.0F * unit},
                .caption = {.face = inputs.text_face, .size = 12.0F * unit},
                .title = {.face = inputs.text_face, .size = 18.0F * unit},
                .numeric = {.face = inputs.numeric_face, .size = 14.0F * unit},
            },
        .elevation = {.low = shadow(base.shade, 4.0F * unit, 1.0F * unit), .high = high},
        .materials =
            {
                .plate =
                    {
                        .fill = base.surface,
                        .radius = 12.0F * unit,
                        .rim = base.rim,
                        .rim_width = 1.0F,
                        .shadow = high,
                    },
            },
        .controls =
            {
                .height = 32.0F * unit,
                .toggle_width = 40.0F * unit,
                .toggle_height = 22.0F * unit,
                .knob_inset = 3.0F * unit,
                .track_thickness = 4.0F * unit,
                .thumb_radius = 8.0F * unit,
                .focus_width = 2.0F * unit,
                .wheel_step = 48.0F * unit,
                .rail_width = 4.0F * unit,
                .popup_gap = 4.0F * unit,
                .chevron = 8.0F * unit,
                .hover_strength = 0.5F,
            },
        .motion = {
            .approach_half_life = timed(std::chrono::milliseconds{40}, inputs),
            .spring_response = timed(std::chrono::milliseconds{300}, inputs),
            .fast = timed(std::chrono::milliseconds{120}, inputs),
            .normal = timed(std::chrono::milliseconds{220}, inputs),
            .standard = easing::out_cubic,
        },
    };
}

auto composite(draw::color base, draw::color layer, f32 strength) -> draw::color {
    const f32 coverage = std::clamp(strength, 0.0F, 1.0F) * static_cast<f32>(layer.a) / 255.0F;
    const draw::color blended = mix(base, draw::with_alpha(layer, base.a), coverage);
    return draw::with_alpha(blended, base.a);
}

}
