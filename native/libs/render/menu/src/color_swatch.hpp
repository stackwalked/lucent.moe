#pragma once

#include <array>
#include <optional>
#include <string_view>

#include <lucent/kit/settings.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::menu::detail {

struct color_swatch_spec {
    kit::color value;
    // Red, green, blue, alpha.
    std::array<std::string_view, 4> channels;
};

// A stand-in until ui has a colour picker: a swatch of the colour that opens a popup with one
// slider per channel, 0 to 255. The new colour on the frame it changes.
auto color_swatch(ui::context& frame, ui::local_key key, const color_swatch_spec& spec)
    -> std::optional<kit::color>;

}
