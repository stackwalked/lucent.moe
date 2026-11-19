#pragma once

#include <span>

#include <lucent/finder/fact_search.hpp>

namespace lucent::finder {

// The facts of each subsystem, as the foreign layer groups their declarations.
auto entity_searches() -> std::span<const fact_search>;
auto view_searches() -> std::span<const fact_search>;

}
