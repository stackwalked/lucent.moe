#pragma once

#include <string_view>

#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

// Running text in the body role, wrapped at the width its parent gives it.
auto label(context& frame, std::string_view utf8) -> void;

}
