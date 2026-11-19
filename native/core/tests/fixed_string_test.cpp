#include <lucent/core/fixed_string.hpp>

#include <concepts>

namespace lucent {
namespace {

template <fixed_string Name>
struct tag {};

// Stands in for a consteval hash: a function of the name that only the compiler ever sees.
template <fixed_string Name>
consteval auto length_of() -> isize {
    return Name.size();
}

}

static_assert(length_of<"fact">() == 4, "a literal is a template argument, read at compile time");
static_assert(fixed_string{"view"}.as_view() == "view", "the text survives the copy");
static_assert(fixed_string{""}.size() == 0, "the empty name is a name");
static_assert(
    std::same_as<decltype(fixed_string{"ab"}), fixed_string<2>>, "the terminator is not stored"
);

static_assert(std::same_as<tag<"entities">, tag<"entities">>, "equal names are one argument");
static_assert(!std::same_as<tag<"entities">, tag<"entity">>, "names of different length differ");
static_assert(!std::same_as<tag<"view">, tag<"vies">>, "names of the same length differ by text");

}
