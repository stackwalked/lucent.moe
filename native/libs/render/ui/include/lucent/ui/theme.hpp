#pragma once

#include <chrono>

#include <lucent/draw/color.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/motion.hpp>

namespace lucent::ui {

enum class theme_preset : u8 {
    dark,
    light,
};

// Everything a theme is derived from: when none of it changes, neither does the theme.
struct theme_inputs {
    draw::color accent;
    theme_preset preset = theme_preset::dark;
    // Multiplies every length: spacing, radii, type and control sizes.
    f32 scale = 1.0F;
    bool is_reduced_motion = false;
    // The text system's faces for running text and for figures.
    text::face_id text_face{};
    text::face_id numeric_face{};
};

struct color_roles {
    // A window's own plate, and what sits above it.
    draw::color surface;
    draw::color raised;
    // What sits below the surface: a slider's or toggle's track.
    draw::color sunken;
    draw::color ink;
    draw::color muted_ink;
    draw::color accent;
    // Ink on accent.
    draw::color accent_ink;
    draw::color danger;
    draw::color focus;
    // Laid over a control at full strength while pressed, at part strength while hovered.
    draw::color state_layer;
};

struct spacing_scale {
    f32 xs = 0.0F;
    f32 s = 0.0F;
    f32 m = 0.0F;
    f32 l = 0.0F;
    f32 xl = 0.0F;
};

struct radius_scale {
    f32 s = 0.0F;
    f32 m = 0.0F;
    f32 l = 0.0F;
};

struct type_roles {
    text::text_style body;
    text::text_style caption;
    text::text_style title;
    text::text_style numeric;
};

struct elevation_levels {
    draw::shadow_style low;
    draw::shadow_style high;
};

// Solid, shadowed, no backdrop pass: what HUD windows sit on.
struct plate_material {
    draw::color fill;
    f32 radius = 0.0F;
    draw::color rim;
    f32 rim_width = 0.0F;
    draw::shadow_style shadow;
};

struct material_set {
    plate_material plate;
};

// Control geometry that isn't spacing: what the widgets size themselves from.
struct control_metrics {
    f32 height = 0.0F;
    f32 toggle_width = 0.0F;
    f32 toggle_height = 0.0F;
    // Between a toggle's track and its knob.
    f32 knob_inset = 0.0F;
    f32 track_thickness = 0.0F;
    f32 thumb_radius = 0.0F;
    f32 focus_width = 0.0F;
    // Scrolled per wheel notch.
    f32 wheel_step = 0.0F;
    f32 rail_width = 0.0F;
    // Between a popup and the element it anchors to.
    f32 popup_gap = 0.0F;
    // A dropdown's chevron, edge to edge.
    f32 chevron = 0.0F;
    // The state layer's strength over a hovered control; a pressed one takes it whole.
    f32 hover_strength = 0.0F;
};

// Reduced motion zeroes every timing, which snaps every primitive.
struct motion_tokens {
    std::chrono::milliseconds approach_half_life{};
    std::chrono::milliseconds spring_response{};
    std::chrono::milliseconds fast{};
    std::chrono::milliseconds normal{};
    easing standard = easing::out_cubic;
};

struct theme {
    color_roles colors;
    spacing_scale spacing;
    radius_scale radii;
    type_roles type;
    elevation_levels elevation;
    material_set materials;
    control_metrics controls;
    motion_tokens motion;
};

auto derive_theme(const theme_inputs& inputs) -> theme;

// base with layer composited over it at strength (0 to 1) of layer's own alpha. Opaque bases stay
// opaque.
auto composite(draw::color base, draw::color layer, f32 strength) -> draw::color;

}
