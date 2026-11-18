#include "names.hpp"

#include <string_view>

#include <Windows.h>

#include <lucent/core/narrow.hpp>

namespace lucent::os::detail {

auto is_same_name(std::wstring_view left, std::wstring_view right) -> bool {
    const auto left_size = narrow<i32>(std::ssize(left));
    const auto right_size = narrow<i32>(std::ssize(right));
    return CompareStringOrdinal(left.data(), left_size, right.data(), right_size, TRUE)
           == CSTR_EQUAL;
}

}
