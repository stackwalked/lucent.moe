#pragma once

#include <optional>
#include <span>
#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

struct dropdown_spec {
    // Borrowed for the call.
    std::span<const std::string_view> options;
    isize selected = 0;
};

// A field showing the selected option. A press on it, or Enter or Space while focused, opens a
// popup below it listing every option; Up and Down step the selection while it is closed. The new
// index on the frame it changes.
auto dropdown(context& frame, local_key key, const dropdown_spec& spec) -> std::optional<isize>;

}
