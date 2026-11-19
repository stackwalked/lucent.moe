#pragma once

#include <filesystem>
#include <vector>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/finder/target.hpp>

#include "cache/binaries.hpp"
#include "latency/step_log.hpp"

namespace lucent::facts {

struct generation {
    isize resolved = 0;
    // Facts that didn't resolve, or whose declaration and search don't match, and modules that
    // couldn't be generated at all.
    isize failed = 0;
    // Core capabilities with a fact that didn't resolve: publishing would refuse a set made from
    // this run.
    isize uncovered_core = 0;
    std::vector<u64> resolved_keys;
    // One generate step per game module, for the update-day log.
    std::vector<step_record> steps;
};

// The built module whose facts are generated, and the cache holding the game's builds.
struct generation_source {
    binaries_cache cache;
    std::filesystem::path module;
};

// Runs the target's searches against each of its game modules' latest build in the binaries cache
// and prints the report: each fact's value and the finders that agreed on it, a warning for each
// finder that found nothing while the rest agreed, and an error for each fact that didn't resolve
// or whose search doesn't fit the module's manifest, and for each core capability left uncovered.
// Writes the resolved values, one `name=value` per line, beside each module build's snapshot
// (facts.txt), for `devkey sign`, and the change from the set before it (changes.txt). Signs
// nothing.
auto generate(
    const generation_source& source,
    const finder::target& target,
    stdx::function_ref<wall_time()> now
) -> result<generation>;

}
