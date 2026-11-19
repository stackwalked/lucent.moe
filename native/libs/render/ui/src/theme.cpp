#include <lucent/ui/theme.hpp>

#include <algorithm>
#include <bit>
#include <chrono>
#include <cmath>
#include <optional>

#include <lucent/draw/color.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/motion.hpp>

namespace lucent::ui {
namespace {

// What a preset fixes, at scale 1; the accent, scale, motion and backdrop fill in the rest.
struct preset_tokens {
    draw::color surface;
    draw::color raised;
    draw::color sunken;
    draw::color ink;
    draw::color muted_ink;
    draw::color danger;
    draw::color state_layer;
    draw::color rim;
    draw::color shade;
    radius_scale radii;
    f32 rim_width = 0.0F;
    draw::color glass_tint;
    f32 glass_blur = 0.0F;
    f32 glass_rim = 0.0F;
    draw::color grain;
    draw::color glass_edge;
};

auto dark_tokens() -> preset_tokens {
    return {
        .surface = {.r = 22, .g = 23, .b = 28, .a = 240},
        .raised = {.r = 44, .g = 46, .b = 56, .a = 210},
        .sunken = {.r = 10, .g = 11, .b = 14, .a = 200},
        .ink = {.r = 236, .g = 237, .b = 242, .a = 255},
        .muted_ink = {.r = 150, .g = 154, .b = 168, .a = 255},
        .danger = {.r = 238, .g = 84, .b = 84, .a = 255},
        .state_layer = {.r = 255, .g = 255, .b = 255, .a = 28},
        .rim = {.r = 255, .g = 255, .b = 255, .a = 20},
        .shade = {.r = 0, .g = 0, .b = 0, .a = 140},
        .radii = {.s = 4.0F, .m = 8.0F, .l = 12.0F},
        .rim_width = 1.0F,
        .glass_tint = {.r = 18, .g = 19, .b = 24, .a = 168},
        .glass_blur = 24.0F,
        .glass_rim = 6.0F,
        .grain = {.r = 255, .g = 255, .b = 255, .a = 10},
        .glass_edge = {.r = 255, .g = 255, .b = 255, .a = 36},
    };
}

auto light_tokens() -> preset_tokens {
    return {
        .surface = {.r = 246, .g = 246, .b = 249, .a = 245},
        .raised = {.r = 255, .g = 255, .b = 255, .a = 220},
        .sunken = {.r = 214, .g = 216, .b = 224, .a = 200},
        .ink = {.r = 22, .g = 23, .b = 28, .a = 255},
        .muted_ink = {.r = 92, .g = 96, .b = 110, .a = 255},
        .danger = {.r = 200, .g = 40, .b = 40, .a = 255},
        .state_layer = {.r = 0, .g = 0, .b = 0, .a = 20},
        .rim = {.r = 0, .g = 0, .b = 0, .a = 24},
        .shade = {.r = 0, .g = 0, .b = 0, .a = 70},
        .radii = {.s = 4.0F, .m = 8.0F, .l = 12.0F},
        .rim_width = 1.0F,
        .glass_tint = {.r = 244, .g = 245, .b = 249, .a = 176},
        .glass_blur = 24.0F,
        .glass_rim = 6.0F,
        .grain = {.r = 0, .g = 0, .b = 0, .a = 8},
        .glass_edge = {.r = 255, .g = 255, .b = 255, .a = 140},
    };
}

auto high_contrast_tokens() -> preset_tokens {
    return {
        .surface = {.r = 0, .g = 0, .b = 0, .a = 255},
        .raised = {.r = 52, .g = 52, .b = 52, .a = 255},
        .sunken = {.r = 40, .g = 40, .b = 40, .a = 255},
        .ink = {.r = 255, .g = 255, .b = 255, .a = 255},
        .muted_ink = {.r = 214, .g = 214, .b = 214, .a = 255},
        .danger = {.r = 255, .g = 96, .b = 96, .a = 255},
        .state_layer = {.r = 255, .g = 255, .b = 255, .a = 56},
        .rim = {.r = 255, .g = 255, .b = 255, .a = 200},
        .shade = {.r = 0, .g = 0, .b = 0, .a = 200},
        .radii = {.s = 2.0F, .m = 4.0F, .l = 6.0F},
        .rim_width = 2.0F,
        .glass_tint = {.r = 0, .g = 0, .b = 0, .a = 236},
        .glass_blur = 8.0F,
        .glass_rim = 0.0F,
        .grain = draw::transparent,
        .glass_edge = {.r = 255, .g = 255, .b = 255, .a = 200},
    };
}

auto tokens_of(theme_preset preset) -> preset_tokens {
    switch (preset) {
    case theme_preset::dark:
        return dark_tokens();
    case theme_preset::light:
        return light_tokens();
    case theme_preset::high_contrast:
        return high_contrast_tokens();
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

auto alpha_of(draw::color tint) -> f32 {
    return static_cast<f32>(tint.a) / 255.0F;
}

auto shadow(draw::color shade, f32 blur, f32 drop) -> draw::shadow_style {
    return {.tint = shade, .blur = blur, .spread = 0.0F, .offset = {.x = 0.0F, .y = drop}};
}

auto timed(std::chrono::milliseconds duration, const theme_inputs& inputs)
    -> std::chrono::milliseconds {
    return inputs.is_reduced_motion ? std::chrono::milliseconds{0} : duration;
}

// The lightness distance glass keeps between its ink and what shows through it.
constexpr f32 ink_contrast = 0.6F;
// The thickest the tint gets: some of the scene always shows.
constexpr f32 thickest_tint = 0.94F;

// The tint's alpha over backdrop: its own, or thicker until the panel sits ink_contrast away from
// the ink's lightness. Lightness is near enough linear in alpha for this to land close.
auto adapted_alpha(const preset_tokens& base, draw::color backdrop) -> f32 {
    const draw::color tint = base.glass_tint;
    const f32 ink = lightness(base.ink);
    const f32 own = alpha_of(tint);
    const f32 behind = lightness(backdrop);
    const f32 tinted = lightness(tint);
    const bool is_light_ink = ink > tinted;
    const f32 wanted = is_light_ink ? ink - ink_contrast : ink + ink_contrast;
    // How far the backdrop is on the ink's side of wanted: none means any alpha holds.
    const f32 excess = is_light_ink ? behind - wanted : wanted - behind;
    const f32 span = is_light_ink ? behind - tinted : tinted - behind;
    if (excess <= 0.0F || span <= 0.0F) {
        return own;
    }
    return std::clamp(excess / span, own, std::max(own, thickest_tint));
}

struct adapted_glass {
    draw::color tint;
    // 0 where the preset's tint already held, to 1 where it had to thicken all the way.
    f32 strain = 0.0F;
};

auto adapt(const preset_tokens& base, const theme_inputs& inputs) -> adapted_glass {
    if (!inputs.backdrop) {
        return {.tint = base.glass_tint, .strain = 0.0F};
    }
    const f32 own = alpha_of(base.glass_tint);
    const f32 alpha = adapted_alpha(base, *inputs.backdrop);
    const f32 room = std::max(thickest_tint - own, 0.001F);
    return {
        .tint = draw::with_alpha(base.glass_tint, channel(0, 255, alpha)),
        .strain = std::clamp((alpha - own) / room, 0.0F, 1.0F),
    };
}

}

auto derive_theme(const theme_inputs& inputs) -> theme {
    const preset_tokens base = tokens_of(inputs.preset);
    const f32 unit = std::max(inputs.scale, 0.25F);
    const draw::color accent = draw::with_alpha(inputs.accent, 255);
    const draw::color white = draw::white;
    const draw::color black{.r = 0, .g = 0, .b = 0, .a = 255};
    const bool is_dark = lightness(base.ink) > 0.5F;
    const draw::shadow_style high = shadow(base.shade, 18.0F * unit, 6.0F * unit);
    const adapted_glass glass = adapt(base, inputs);
    return {
        .colors =
            {
                .surface = base.surface,
                .raised = base.raised,
                .sunken = base.sunken,
                .ink = base.ink,
                // Muted ink nears full ink as the scene strains the glass, so captions stay read.
                .muted_ink = mix(base.muted_ink, base.ink, glass.strain * 0.5F),
                .accent = accent,
                .accent_ink = lightness(accent) > 0.6F ? black : white,
                .danger = base.danger,
                .focus = mix(accent, is_dark ? white : black, 0.25F),
                .state_layer = base.state_layer,
                .selection = draw::with_alpha(accent, 96),
            },
        .spacing =
            {
                .xs = 2.0F * unit,
                .s = 4.0F * unit,
                .m = 8.0F * unit,
                .l = 12.0F * unit,
                .xl = 20.0F * unit,
            },
        .radii =
            {
                .s = base.radii.s * unit,
                .m = base.radii.m * unit,
                .l = base.radii.l * unit,
            },
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
                        .radius = base.radii.l * unit,
                        .rim = base.rim,
                        .rim_width = base.rim_width,
                        .shadow = high,
                    },
                .glass =
                    {
                        .tint = glass.tint,
                        .blur = base.glass_blur * unit,
                        .rim = base.glass_rim * unit,
                        .grain = base.grain,
                        .radius = base.radii.l * unit,
                        .edge = base.glass_edge,
                        .edge_width = base.rim_width,
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
                .rail_reach = 10.0F * unit,
                .popup_gap = 4.0F * unit,
                .chevron = 8.0F * unit,
                .hover_strength = 0.5F,
                .caret_width = 1.5F * unit,
                .picker_size = 176.0F * unit,
                .title_height = 24.0F * unit,
            },
        .motion = {
            .approach_half_life = timed(std::chrono::milliseconds{40}, inputs),
            .spring_response = timed(std::chrono::milliseconds{300}, inputs),
            .fast = timed(std::chrono::milliseconds{120}, inputs),
            .normal = timed(std::chrono::milliseconds{220}, inputs),
            .standard = easing::out_cubic,
            .caret_blink = timed(std::chrono::milliseconds{530}, inputs),
            .tooltip_delay = std::chrono::milliseconds{500},
        },
    };
}

auto is_unchanged(const theme_inputs& before, const theme_inputs& after) -> bool {
    return before.accent == after.accent
           && before.preset == after.preset
           && std::bit_cast<u32>(before.scale) == std::bit_cast<u32>(after.scale)
           && before.is_reduced_motion == after.is_reduced_motion
           && before.backdrop == after.backdrop
           && before.text_face == after.text_face
           && before.numeric_face == after.numeric_face;
}

auto composite(draw::color base, draw::color layer, f32 strength) -> draw::color {
    const f32 coverage = std::clamp(strength, 0.0F, 1.0F) * static_cast<f32>(layer.a) / 255.0F;
    const draw::color blended = mix(base, draw::with_alpha(layer, base.a), coverage);
    return draw::with_alpha(blended, base.a);
}

auto lightness(draw::color tint) -> f32 {
    return ((0.2126F * static_cast<f32>(tint.r)) + (0.7152F * static_cast<f32>(tint.g))
               + (0.0722F * static_cast<f32>(tint.b)))
           / 255.0F;
}

auto plate_decoration(const plate_material& plate) -> decoration {
    return {
        .fill = draw::solid(plate.fill),
        .radius = plate.radius,
        .outline = plate.rim,
        .outline_width = plate.rim_width,
        .shadow = plate.shadow,
        .glass = std::nullopt,
    };
}

auto glass_decoration(const glass_material& glass, std::optional<draw::light_key> light)
    -> decoration {
    return {
        .fill = draw::solid(glass.tint),
        .radius = glass.radius,
        .outline = glass.edge,
        .outline_width = glass.edge_width,
        .shadow = glass.shadow,
        .glass = glass_look{
            .blur = glass.blur,
            .rim = glass.rim,
            .grain = glass.grain,
            .light = light,
        },
    };
}

}
