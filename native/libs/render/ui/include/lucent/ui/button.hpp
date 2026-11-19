#pragma once

#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>

namespace lucent::ui {

// Act on is_activated: a click, or Enter or Space while focused.
auto button(context& frame, local_key key, std::string_view caption) -> interaction;

}
