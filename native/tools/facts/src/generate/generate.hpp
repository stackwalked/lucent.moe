#pragma once

#include <filesystem>
#include <vector>

#include <lucent/finder/target.hpp>

namespace lucent::facts {

struct generation {
    isize resolved = 0;
    // Facts that didn't resolve, or whose declaration and search don't match.
    isize failed = 0;
    // Core capabilities with a fact that didn't resolve: publishing would refuse a set made from
    // this run.
    isize uncovered_core = 0;
    std::vector<u64> resolved_keys;
};

// Runs the target's searches against each of its game modules' latest build in the binaries cache
// and prints the report: each fact's value and the finders that agreed on it, a warning for each
// finder that found nothing while the rest agreed, and an error for each fact that didn't resolve
// or whose search doesn't fit the module's manifest, and for each core capability left uncovered.
// Writes the resolved values, one `name=value` per line, beside each module build's snapshot
// (facts.txt), for `devkey sign`. Signs nothing.
auto generate(const std::filesystem::path& module, const finder::target& target)
    -> result<generation>;

}
