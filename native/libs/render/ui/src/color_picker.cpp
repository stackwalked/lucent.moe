#include <lucent/ui/color_picker.hpp>

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>

#include <lucent/core/flags.hpp>
#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/text_field.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {
namespace {

constexpr f32 hue_sectors = 6.0F;

auto unit_of(u8 channel) -> f32 {
    return static_cast<f32>(channel) / 255.0F;
}

auto channel_of(f32 unit) -> u8 {
    return static_cast<u8>(std::lround(std::clamp(unit, 0.0F, 1.0F) * 255.0F));
}

auto linear(draw::color from, draw::color until, draw::vec2 start, draw::vec2 end) -> draw::paint {
    return {
        .kind = draw::paint_kind::linear,
        .from = from,
        .to = until,
        .start = start,
        .end = end,
    };
}

auto boxed(const draw::rect& area) -> draw::rounded_rect {
    return {.bounds = area, .radii = draw::uniform(0.0F)};
}

// Where the cursor is across area, each axis 0 to 1.
auto fraction_in(const draw::rect& area, draw::vec2 cursor) -> draw::vec2 {
    const f32 width = std::max(area.max.x - area.min.x, 1.0F);
    const f32 height = std::max(area.max.y - area.min.y, 1.0F);
    return {
        .x = std::clamp((cursor.x - area.min.x) / width, 0.0F, 1.0F),
        .y = std::clamp((cursor.y - area.min.y) / height, 0.0F, 1.0F),
    };
}

// What the picker's parts draw from, copied out of the frame.
struct picker_look {
    hsv shade;
    draw::color current;
    draw::color ring;
    draw::color shadow_ring;
    f32 ring_radius = 0.0F;
    f32 ring_width = 0.0F;
};

auto draw_marker(draw::draw_list& list, draw::vec2 centre, const picker_look& look) -> void {
    const draw::circle ring{.centre = centre, .radius = look.ring_radius};
    list.stroke(ring, draw::solid(look.shadow_ring), {.width = look.ring_width * 2.0F});
    list.stroke(ring, draw::solid(look.ring), {.width = look.ring_width});
}

auto draw_square(draw::draw_list& list, const draw::rect& area, const picker_look& look) -> void {
    const draw::color pure =
        from_hsv({.hue = look.shade.hue, .saturation = 1.0F, .value = 1.0F}, 255);
    list.fill(boxed(area), draw::solid(pure));
    list.fill(
        boxed(area),
        linear(
            draw::white,
            draw::with_alpha(draw::white, 0),
            area.min,
            {.x = area.max.x, .y = area.min.y}
        )
    );
    const draw::color black{.r = 0, .g = 0, .b = 0, .a = 255};
    list.fill(
        boxed(area),
        linear(draw::with_alpha(black, 0), black, area.min, {.x = area.min.x, .y = area.max.y})
    );
    draw_marker(
        list,
        {
            .x = area.min.x + ((area.max.x - area.min.x) * look.shade.saturation),
            .y = area.min.y + ((area.max.y - area.min.y) * (1.0F - look.shade.value)),
        },
        look
    );
}

auto draw_hue(draw::draw_list& list, const draw::rect& area, const picker_look& look) -> void {
    const f32 width = area.max.x - area.min.x;
    for (isize sector = 0; sector < static_cast<isize>(hue_sectors); ++sector) {
        const f32 from = static_cast<f32>(sector) / hue_sectors;
        const f32 until = static_cast<f32>(sector + 1) / hue_sectors;
        const draw::rect band{
            .min = {.x = area.min.x + (width * from), .y = area.min.y},
            .max = {.x = area.min.x + (width * until), .y = area.max.y},
        };
        list.fill(
            boxed(band),
            linear(
                from_hsv({.hue = from, .saturation = 1.0F, .value = 1.0F}, 255),
                from_hsv({.hue = until, .saturation = 1.0F, .value = 1.0F}, 255),
                band.min,
                {.x = band.max.x, .y = band.min.y}
            )
        );
    }
    const f32 middle = (area.min.y + area.max.y) / 2.0F;
    draw_marker(list, {.x = area.min.x + (width * look.shade.hue), .y = middle}, look);
}

auto draw_alpha(draw::draw_list& list, const draw::rect& area, const picker_look& look) -> void {
    list.fill(
        boxed(area),
        linear(
            draw::with_alpha(look.current, 0),
            draw::with_alpha(look.current, 255),
            area.min,
            {.x = area.max.x, .y = area.min.y}
        )
    );
    const f32 middle = (area.min.y + area.max.y) / 2.0F;
    const f32 reach = unit_of(look.current.a);
    draw_marker(list, {.x = area.min.x + ((area.max.x - area.min.x) * reach), .y = middle}, look);
}

auto part_style(size_rule width, f32 height) -> box_style {
    return {
        .flow = direction::row,
        .width = width,
        .height = fixed(height),
        .gap = 0.0F,
        .main = main_align::start,
        .cross = cross_align::start,
    };
}

// One draggable part of the picker: where the press holding it is, across its last rect.
auto dragged(context& frame, local_key key) -> std::optional<draw::vec2> {
    const interaction hit = frame.interact(frame.id_of(key), flags{sense::drag});
    if (!hit.is_pressed || !hit.rect || !hit.cursor) {
        return std::nullopt;
    }
    return fraction_in(*hit.rect, *hit.cursor);
}

struct picking {
    element_id swatch{};
    draw::color edited;
};

// The popup's parts, the colour edited by whichever is held, and the hex field.
auto declare_parts(context& frame, picking& picked) -> void {
    const theme& tokens = frame.tokens();
    const element_id hue_memory = child_id(picked.swatch, ui::key<"hue">());
    hsv shade = to_hsv(picked.edited);
    // Grey and black have no hue of their own: the one last picked holds.
    if (shade.saturation <= 0.0F || shade.value <= 0.0F) {
        shade.hue = frame.kept(hue_memory).value_or(shade.hue);
    }
    u8 alpha = picked.edited.a;
    if (const std::optional<draw::vec2> spot = dragged(frame, ui::key<"square">())) {
        shade.saturation = spot->x;
        shade.value = 1.0F - spot->y;
    }
    if (const std::optional<draw::vec2> spot = dragged(frame, ui::key<"hue">())) {
        shade.hue = spot->x;
    }
    if (const std::optional<draw::vec2> spot = dragged(frame, ui::key<"alpha">())) {
        alpha = channel_of(spot->x);
    }
    frame.keep(hue_memory, shade.hue);
    const draw::color dragged_to = from_hsv(shade, alpha);
    if (dragged_to != picked.edited) {
        picked.edited = dragged_to;
    }
    const picker_look look{
        .shade = shade,
        .current = picked.edited,
        .ring = draw::white,
        .shadow_ring = {.r = 0, .g = 0, .b = 0, .a = 120},
        .ring_radius = tokens.controls.thumb_radius / 2.0F,
        .ring_width = tokens.controls.focus_width / 1.5F,
    };
    const f32 bar = tokens.controls.thumb_radius * 1.5F;
    frame.custom(
        ui::key<"square">(),
        part_style(grow(), tokens.controls.picker_size * 0.75F),
        [look](draw::draw_list& list, const draw::rect& area) { draw_square(list, area, look); }
    );
    frame.custom(
        ui::key<"hue">(),
        part_style(grow(), bar),
        [look](draw::draw_list& list, const draw::rect& area) { draw_hue(list, area, look); }
    );
    frame.custom(
        ui::key<"alpha">(),
        part_style(grow(), bar),
        [look](draw::draw_list& list, const draw::rect& area) { draw_alpha(list, area, look); }
    );
    const element_id hex = frame.id_of(ui::key<"hex">());
    // While the field has focus it shows what is typed, valid or not; otherwise the colour's code.
    const std::string code = frame.focused() == hex
                                 ? frame.field(hex, hex_of(picked.edited)).buffer.text()
                                 : hex_of(picked.edited);
    const text_field_outcome typed = text_field(
        frame,
        ui::key<"hex">(),
        {.utf8 = code, .hint = {}, .lines = text_lines::single, .visible_lines = 1}
    );
    if (typed.edited) {
        if (const std::optional<draw::color> parsed = from_hex(*typed.edited)) {
            picked.edited = *parsed;
        }
    }
}

}

auto to_hsv(draw::color rgb) -> hsv {
    const f32 red = unit_of(rgb.r);
    const f32 green = unit_of(rgb.g);
    const f32 blue = unit_of(rgb.b);
    const u8 top = std::max({rgb.r, rgb.g, rgb.b});
    const f32 high = unit_of(top);
    const f32 chroma = high - std::min({red, green, blue});
    f32 hue = 0.0F;
    if (chroma > 0.0F) {
        if (top == rgb.r) {
            hue = std::fmod(((green - blue) / chroma) + hue_sectors, hue_sectors);
        } else if (top == rgb.g) {
            hue = ((blue - red) / chroma) + 2.0F;
        } else {
            hue = ((red - green) / chroma) + 4.0F;
        }
    }
    return {
        .hue = hue / hue_sectors,
        .saturation = high > 0.0F ? chroma / high : 0.0F,
        .value = high,
    };
}

auto from_hsv(hsv shade, u8 alpha) -> draw::color {
    const f32 hue = std::fmod(std::clamp(shade.hue, 0.0F, 1.0F), 1.0F) * hue_sectors;
    const f32 saturation = std::clamp(shade.saturation, 0.0F, 1.0F);
    const f32 value = std::clamp(shade.value, 0.0F, 1.0F);
    const f32 chroma = value * saturation;
    const f32 second = chroma * (1.0F - std::abs(std::fmod(hue, 2.0F) - 1.0F));
    const f32 low = value - chroma;
    std::array<f32, 3> rgb{};
    switch (static_cast<i32>(hue)) {
    case 0:
        rgb = {chroma, second, 0.0F};
        break;
    case 1:
        rgb = {second, chroma, 0.0F};
        break;
    case 2:
        rgb = {0.0F, chroma, second};
        break;
    case 3:
        rgb = {0.0F, second, chroma};
        break;
    case 4:
        rgb = {second, 0.0F, chroma};
        break;
    default:
        rgb = {chroma, 0.0F, second};
        break;
    }
    return {
        .r = channel_of(rgb[0] + low),
        .g = channel_of(rgb[1] + low),
        .b = channel_of(rgb[2] + low),
        .a = alpha,
    };
}

auto hex_of(draw::color rgba) -> std::string {
    constexpr std::string_view digits = "0123456789abcdef";
    std::string code{'#'};
    for (const u8 channel : {rgba.r, rgba.g, rgba.b, rgba.a}) {
        code.push_back(digits.at(channel >> 4U));
        code.push_back(digits.at(channel & 0xfU));
    }
    return code;
}

auto from_hex(std::string_view hex) -> std::optional<draw::color> {
    if (hex.starts_with('#')) {
        hex.remove_prefix(1);
    }
    if (hex.size() != 6 && hex.size() != 8) {
        return std::nullopt;
    }
    std::array<u8, 4> channels{0, 0, 0, 255};
    for (usize index = 0; index < hex.size() / 2; ++index) {
        const std::string_view pair = hex.substr(index * 2, 2);
        u8 parsed = 0;
        const char* const begin = std::to_address(pair.begin());
        const char* const end = std::to_address(pair.end());
        const std::from_chars_result read = std::from_chars(begin, end, parsed, 16);
        if (read.ec != std::errc{} || read.ptr != end) {
            return std::nullopt;
        }
        channels.at(index) = parsed;
    }
    return draw::color{.r = channels[0], .g = channels[1], .b = channels[2], .a = channels[3]};
}

auto color_picker(context& frame, local_key key, draw::color value) -> std::optional<draw::color> {
    const theme& tokens = frame.tokens();
    const interaction hit = frame.interact(frame.id_of(key), flags{sense::click, sense::focus});
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
            .flow = direction::row,
            .width = fixed(tokens.controls.toggle_width),
            .height = fixed(tokens.controls.toggle_height),
            .gap = 0.0F,
            .main = main_align::start,
            .cross = cross_align::start,
            .look =
                {
                    .fill = draw::solid(value),
                    .radius = tokens.radii.s,
                    .outline = hit.is_focused ? tokens.colors.focus : tokens.colors.muted_ink,
                    .outline_width = tokens.controls.focus_width,
                    .shadow = std::nullopt,
                    .glass = std::nullopt,
                },
        },
        [] {}
    );
    picking picked{.swatch = hit.id, .edited = value};
    decoration look = plate_decoration(tokens.materials.plate);
    look.radius = tokens.radii.m;
    frame.popup(
        hit.id,
        {
            .flow = direction::column,
            .width = fixed(tokens.controls.picker_size + (2.0F * tokens.spacing.m)),
            .height = fit(),
            .padding = even(tokens.spacing.m),
            .gap = tokens.spacing.m,
            .main = main_align::start,
            .cross = cross_align::stretch,
            .look = look,
        },
        [&] { declare_parts(frame, picked); }
    );
    if (picked.edited == value) {
        return std::nullopt;
    }
    return picked.edited;
}

}
