#pragma once

#include <algorithm>
#include <array>
#include <span>
#include <string_view>

#include <lucent/core/narrow.hpp>

namespace lucent {

// A string a template argument can carry, so a name is used at compile time (hashed, checked) and
// never has to reach the binary as text. The struct rule bends twice, both forced by the language:
// a structural type keeps its data public, and `f<"name">()` needs a converting constructor from
// the literal. Every member that reads the text is consteval, so none of it runs at run time.
template <usize N>
struct fixed_string {
    // NOLINTNEXTLINE(google-explicit-constructor,cppcoreguidelines-explicit-constructor,misc-explicit-constructor,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): a literal is a C array, converted implicitly in a template argument.
    consteval fixed_string(const char (&literal)[N + 1]) {
        const std::span<const char, N + 1> text{literal};
        LUCENT_INVARIANT(text.back() == '\0');
        std::ranges::copy(text.template first<N>(), chars.begin());
    }

    consteval auto size() const -> isize {
        return narrow<isize>(N);
    }

    consteval auto as_view() const -> std::string_view {
        return {chars.data(), N};
    }

    friend auto operator==(const fixed_string&, const fixed_string&) -> bool = default;

    std::array<char, N> chars{};
};

// The literal's terminator is not part of the name.
template <usize N>
// NOLINTNEXTLINE(cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): a string literal.
fixed_string(const char (&)[N]) -> fixed_string<N - 1>;

}
