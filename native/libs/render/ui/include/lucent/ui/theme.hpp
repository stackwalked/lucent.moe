#pragma once

#include <chrono>
#include <optional>

#include <lucent/draw/color.hpp>
#include <lucent/draw/layer.hpp>
#include <lucent/draw/shadow_style.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/motion.hpp>

namespace lucent::ui {

// A whole set of tokens: colours, radii and both materials. The accent, scale, motion preference
// and backdrop are laid over whichever is chosen.
enum class theme_preset : u8 {
    dark,
    light,
    // Opaque surfaces, pure ink and wide rims, for players who need the menu to stand out.
    high_contrast,
};

// Everything a theme is derived from: when none of it changes, neither does the theme.
struct theme_inputs {
    draw::color accent;
    theme_preset preset = theme_preset::dark;
    // Multiplies every length: spacing, radii, type and control sizes.
    f32 scale = 1.0F;
    bool is_reduced_motion = false;
    // The light glass last sampled behind itself; absent until the backend reports one.
    std::optional<draw::color> backdrop = std::nullopt;
    // The text system's faces for running text and for figures.
    text::face_id text_face{};
    text::face_id numeric_face{};
};

// Whether after derives the same theme as before: every input alike, bit for bit.
auto is_unchanged(const theme_inputs& before, const theme_inputs& after) -> bool;

struct color_roles {
    // A window's own plate, and what sits above it.
    draw::color surface;
    draw::color raised;
    // What sits below the surface: a slider's or toggle's track, a text field.
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
    // Behind selected text.
    draw::color selection;
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

// Solid, shadowed, no backdrop pass: what HUD windows sit on, since glass over a bright scene reads
// as a mid-tone slab.
struct plate_material {
    draw::color fill;
    f32 radius = 0.0F;
    draw::color rim;
    f32 rim_width = 0.0F;
    draw::shadow_style shadow;
};

// The scene behind, blurred, tinted and grained, with a bevel of bent light at the edge: what the
// menu sits on. The tint thickens over a backdrop that would wash the ink out.
struct glass_material {
    draw::color tint;
    // In units.
    f32 blur = 0.0F;
    f32 rim = 0.0F;
    draw::color grain;
    f32 radius = 0.0F;
    // A thin highlight inside the edge.
    draw::color edge;
    f32 edge_width = 0.0F;
    draw::shadow_style shadow;
};

struct material_set {
    plate_material plate;
    glass_material glass;
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
    // How wide the strip along a scroll's edge that takes a press on its rail is.
    f32 rail_reach = 0.0F;
    // Between a popup and the element it anchors to.
    f32 popup_gap = 0.0F;
    // A dropdown's chevron, edge to edge.
    f32 chevron = 0.0F;
    // The state layer's strength over a hovered control; a pressed one takes it whole.
    f32 hover_strength = 0.0F;
    f32 caret_width = 0.0F;
    // A colour picker's saturation and value square, edge to edge.
    f32 picker_size = 0.0F;
    // A HUD window's title bar.
    f32 title_height = 0.0F;
};

// Reduced motion zeroes every timing, which snaps every primitive.
struct motion_tokens {
    std::chrono::milliseconds approach_half_life{};
    std::chrono::milliseconds spring_response{};
    std::chrono::milliseconds fast{};
    std::chrono::milliseconds normal{};
    easing standard = easing::out_cubic;
    // A caret's half period; zero holds it steady.
    std::chrono::milliseconds caret_blink{};
    // Not motion, so reduced motion leaves it: how long the cursor rests before a tooltip shows.
    std::chrono::milliseconds tooltip_delay{};
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

// Rec. 709 weights on the sRGB values, 0 to 1: rough, but enough to tell light from dark.
auto lightness(draw::color tint) -> f32;

auto plate_decoration(const plate_material& plate) -> decoration;
// light names the backdrop's sampled light, for the glue to feed back as theme_inputs::backdrop.
auto glass_decoration(const glass_material& glass, std::optional<draw::light_key> light)
    -> decoration;

}
