#pragma once

#include <optional>
#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

struct slider_spec {
    std::string_view caption;
    f32 value = 0.0F;
    f32 min = 0.0F;
    f32 max = 1.0F;
    // Values land on min plus a whole number of steps; zero leaves them continuous.
    f32 step = 0.0F;
};

// Caption and value above a track. Dragging the track, or Left, Right, Home and End while focused,
// sets it. The new value on a frame it changes.
auto slider(context& frame, local_key key, const slider_spec& spec) -> std::optional<f32>;

// The value a fraction (0 to 1) along the track stands for, stepped and clamped.
auto slider_value(const slider_spec& spec, f32 fraction) -> f32;

}
