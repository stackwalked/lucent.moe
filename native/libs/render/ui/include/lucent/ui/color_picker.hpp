#pragma once

#include <optional>
#include <string>
#include <string_view>

#include <lucent/draw/color.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

// Hue, saturation and value, each 0 to 1; hue runs red, yellow, green, cyan, blue, magenta.
struct hsv {
    f32 hue = 0.0F;
    f32 saturation = 0.0F;
    f32 value = 0.0F;
};

auto to_hsv(draw::color rgb) -> hsv;
auto from_hsv(hsv shade, u8 alpha) -> draw::color;

// "#rrggbbaa", lower case.
auto hex_of(draw::color rgba) -> std::string;
// "#rrggbb" or "#rrggbbaa", the hash optional, either case; absent for anything else.
auto from_hex(std::string_view hex) -> std::optional<draw::color>;

// A swatch of the colour. A press on it, or Enter or Space while focused, opens a popup below it:
// a saturation and value square, a hue bar, an alpha bar and the colour's hex code in a text
// field. The new colour on a frame it changes.
auto color_picker(context& frame, local_key key, draw::color value) -> std::optional<draw::color>;

}
