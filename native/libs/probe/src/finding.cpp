#include <lucent/probe/finding.hpp>

#include <algorithm>
#include <expected>
#include <span>

namespace lucent::probe {
namespace {

template <typename Value>
auto one_distinct(std::span<const Value> candidates) -> finding {
    if (candidates.empty()) {
        return std::unexpected(miss::none);
    }
    const Value first = candidates.front();
    if (!std::ranges::all_of(candidates, [&](Value candidate) { return candidate == first; })) {
        return std::unexpected(miss::ambiguous);
    }
    return u64{first};
}

}

auto one(std::span<const u64> candidates) -> finding {
    return one_distinct(candidates);
}

auto one(std::span<const u32> candidates) -> finding {
    return one_distinct(candidates);
}

}
