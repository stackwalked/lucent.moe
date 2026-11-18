#pragma once

#include <concepts>
#include <type_traits>
#include <utility>
#include <variant>

namespace lucent {
namespace detail {

// Inheriting the callables is how one object gets all their call operators: the dialect's single
// sanctioned use of implementation inheritance, kept inside match().
template <std::move_constructible... Cases>
// NOLINTNEXTLINE(misc-multiple-inheritance): the overload-set idiom; see above.
struct overloaded : Cases... {
    using Cases::operator()...;
};

}

template <typename T>
concept variant_like = requires { std::variant_size_v<std::remove_cvref_t<T>>; };

// Visits a variant with one callable per alternative. A missing alternative fails to compile, so
// adding one to the variant finds every place that must handle it.
template <variant_like Variant, std::move_constructible... Cases>
constexpr auto match(Variant&& value, Cases&&... cases) -> decltype(auto) {
    return std::visit(
        detail::overloaded<std::remove_cvref_t<Cases>...>{std::forward<Cases>(cases)...},
        std::forward<Variant>(value)
    );
}

}
