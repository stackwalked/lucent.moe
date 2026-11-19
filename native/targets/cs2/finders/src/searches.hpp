#pragma once

#include <span>

#include <lucent/finder/fact_search.hpp>

namespace lucent::finder {

// The facts of each subsystem, as the foreign layer groups their declarations.
auto entity_searches() -> std::span<const fact_search>;
auto view_searches() -> std::span<const fact_search>;

// Not yet in cs2_target(): the generator refuses a search whose fact the module doesn't link, and
// these fields' declarations arrive with the foreign layer that reads them.
auto schema_searches() -> std::span<const fact_search>;

}
