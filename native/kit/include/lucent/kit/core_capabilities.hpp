#pragma once

#include <span>
#include <vector>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// The unavailable core capabilities, by key, in declaration order.
struct core_judgment {
    // A member fact is rejected or unresolved in a module that is loaded, or isn't linked at all:
    // it can't become available. Refuses the start, or ends a running session.
    std::vector<u64> failed;
    // Every member fact that isn't resolved belongs to a module the game hasn't loaded yet: the
    // start goes on without it, and it is judged again once that module loads.
    std::vector<u64> waiting;

    auto operator==(const core_judgment&) const -> bool = default;
};

// The core capabilities in declared that aren't available in records, as they stand while the
// modules in loaded (by index) are loaded.
auto judge_core(
    std::span<const declared_capability> declared,
    std::span<const fact_record> records,
    std::span<const u8> loaded
) -> core_judgment;

}
