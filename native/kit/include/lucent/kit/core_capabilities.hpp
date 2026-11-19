#pragma once

#include <span>
#include <vector>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// The keys of the core capabilities in declared that are unavailable: a member fact of theirs
// isn't resolved in records, or isn't there at all. In declaration order; empty lets the start
// go on.
auto unavailable_core(
    std::span<const declared_capability> declared, std::span<const fact_record> records
) -> std::vector<u64>;

}
