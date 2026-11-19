#pragma once

#include <type_traits>

#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// The fact kinds foreign memory is reached through.
template <typename T>
inline constexpr bool is_fact = is_global_fact<T> || is_field_fact<T> || is_value_fact<T>;

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.

// Whether every parameter names a fact object. A requires clause rather than `const C auto&`:
// Clang doesn't support a constrained placeholder on a reference template parameter yet.
template <const auto&... Facts>
inline constexpr bool are_facts = (is_fact<std::remove_cvref_t<decltype(Facts)>> && ...);

// Facts a feature can require together, named by the fact objects themselves. A type, never data:
// access built on it knows at compile time which facts it may reach.
template <const auto&... Facts>
    requires are_facts<Facts...>
struct capability {};

template <typename T>
inline constexpr bool is_capability = false;

template <const auto&... Facts>
inline constexpr bool is_capability<capability<Facts...>> = true;

template <typename T>
concept capability_like = is_capability<T>;

// Whether Fact is one of Capability's facts: the same object, not merely the same kind.
template <const auto& Fact, typename Capability>
inline constexpr bool is_part_of = false;

template <const auto& Fact, const auto&... Facts>
inline constexpr bool is_part_of<Fact, capability<Facts...>> =
    ((static_cast<const void*>(&Fact) == static_cast<const void*>(&Facts)) || ...);

// Available when every one of its facts resolved.
template <const auto&... Facts>
auto is_available(capability<Facts...> /*required*/) -> bool {
    return ((Facts.record().status == fact_status::resolved) && ...);
}

// NOLINTEND(readability-redundant-parentheses)

}
