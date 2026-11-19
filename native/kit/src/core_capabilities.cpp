#include <lucent/kit/core_capabilities.hpp>

#include <algorithm>
#include <span>
#include <vector>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {
namespace {

enum class member_state : u8 { available, waiting, failed };

auto state_of(u64 member, std::span<const fact_record> records, std::span<const u8> loaded)
    -> member_state {
    const auto found = std::ranges::find(records, member, &fact_record::key);
    if (found == records.end()) {
        return member_state::failed;
    }
    if (status_of(*found) == fact_status::resolved) {
        return member_state::available;
    }
    return std::ranges::contains(loaded, found->module) ? member_state::failed
                                                        : member_state::waiting;
}

}

auto judge_core(
    std::span<const declared_capability> declared,
    std::span<const fact_record> records,
    std::span<const u8> loaded
) -> core_judgment {
    core_judgment judged;
    for (const declared_capability& capability : declared) {
        if (capability.level != capability_level::core) {
            continue;
        }
        std::vector<member_state> members;
        members.reserve(capability.members.size());
        for (const u64 member : capability.members) {
            members.push_back(state_of(member, records, loaded));
        }
        if (std::ranges::contains(members, member_state::failed)) {
            judged.failed.push_back(capability.key);
        } else if (std::ranges::contains(members, member_state::waiting)) {
            judged.waiting.push_back(capability.key);
        }
    }
    return judged;
}

}
