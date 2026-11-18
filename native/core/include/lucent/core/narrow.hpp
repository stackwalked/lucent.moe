#pragma once

#include <concepts>
#include <type_traits>
#include <utility>

namespace lucent {

// The integer types std::in_range accepts: not bool, not the character types.
template <typename T>
concept strict_integral = std::integral<T>
                          && !std::same_as<std::remove_cv_t<T>, bool>
                          && !std::same_as<std::remove_cv_t<T>, char>
                          && !std::same_as<std::remove_cv_t<T>, wchar_t>
                          && !std::same_as<std::remove_cv_t<T>, char8_t>
                          && !std::same_as<std::remove_cv_t<T>, char16_t>
                          && !std::same_as<std::remove_cv_t<T>, char32_t>;

// Converts between integer types, failing the invariant if the value does not fit. Floating-point
// conversions lose precision by design and are written as static_cast instead.
template <strict_integral To, strict_integral From>
constexpr auto narrow(From value) -> To {
    LUCENT_INVARIANT(std::in_range<To>(value));
    return static_cast<To>(value);
}

}
