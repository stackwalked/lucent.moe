#include <lucent/kit/core_capabilities.hpp>

#include <algorithm>
#include <span>
#include <vector>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {
namespace {

auto is_resolved(std::span<const fact_record> records, u64 key) -> bool {
    const auto found = std::ranges::find(records, key, &fact_record::key);
    return found != records.end() && status_of(*found) == fact_status::resolved;
}

}

auto unavailable_core(
    std::span<const declared_capability> declared, std::span<const fact_record> records
) -> std::vector<u64> {
    std::vector<u64> unavailable;
    for (const declared_capability& capability : declared) {
        if (capability.level != capability_level::core) {
            continue;
        }
        const bool is_available = std::ranges::all_of(capability.members, [&](u64 member) {
            return is_resolved(records, member);
        });
        if (!is_available) {
            unavailable.push_back(capability.key);
        }
    }
    return unavailable;
}

}
