#pragma once

#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

// A caption on a plate below anchor, once the cursor has rested on it for the theme's delay. It
// never takes input; leaving the anchor or pressing hides it.
auto tooltip(context& frame, element_id anchor, std::string_view utf8) -> void;

}
