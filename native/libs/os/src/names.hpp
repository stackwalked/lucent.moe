#pragma once

#include <string_view>

namespace lucent::os::detail {

// File and module names compare the way Windows compares them: ordinal, ignoring case.
auto is_same_name(std::wstring_view left, std::wstring_view right) -> bool;

}
