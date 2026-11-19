#pragma once

#include <span>

#include <lucent/finders/fact_search.hpp>

namespace lucent::finders {

// The facts of each subsystem, as the foreign layer groups their declarations.
auto entity_searches() -> std::span<const fact_search>;
auto view_searches() -> std::span<const fact_search>;

}
