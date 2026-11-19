#include <lucent/refract/function.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <flat_map>
#include <iterator>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/refract/instruction.hpp>
#include <lucent/refract/refusal.hpp>

namespace lucent::refract {
namespace {

enum class edge_kind : u8 { fall_through, branch };

struct edge {
    u64 target = 0;
    edge_kind kind = edge_kind::branch;
};

auto edges_of(const instruction& lifted) -> std::vector<edge> {
    const edge next{
        .target = lifted.address + narrow<u64>(lifted.length),
        .kind = edge_kind::fall_through,
    };
    return match(
        lifted.next,
        [&](const fall_through&) { return std::vector<edge>{next}; },
        [](const jump& jumped) {
            return std::vector<edge>{{.target = jumped.target, .kind = edge_kind::branch}};
        },
        [&](const branch& taken) {
            return std::vector<edge>{{.target = taken.target, .kind = edge_kind::branch}, next};
        },
        [](const leave&) { return std::vector<edge>{}; }
    );
}

auto refuse(refusal_reason reason, u64 address) -> std::unexpected<refusal> {
    return std::unexpected{refusal{.reason = reason, .address = address, .mnemonic = {}}};
}

}

auto lift_function(std::span<const std::byte> code, u64 address)
    -> std::expected<function, refusal> {
    const u64 end = address + code.size();
    std::flat_map<u64, instruction> lifted;
    std::vector<u64> pending{address};
    while (!pending.empty()) {
        const u64 cursor = pending.back();
        pending.pop_back();
        if (lifted.contains(cursor)) {
            continue;
        }
        instruction found =
            LUCENT_TRY(lift_instruction(code.subspan(narrow<usize>(cursor - address)), cursor));
        for (const edge& next : edges_of(found)) {
            if (next.target >= address && next.target < end) {
                pending.push_back(next.target);
                continue;
            }
            return refuse(
                next.kind == edge_kind::fall_through ? refusal_reason::runs_off_end
                                                     : refusal_reason::branch_outside_function,
                cursor
            );
        }
        lifted.emplace(cursor, std::move(found));
    }

    function result{
        .entry = address,
        .instructions = std::move(lifted).extract().values,
    };
    const auto overlap = std::ranges::adjacent_find(
        result.instructions, [](const instruction& before, const instruction& after) {
            return before.address + narrow<u64>(before.length) > after.address;
        }
    );
    if (overlap != result.instructions.end()) {
        return refuse(refusal_reason::overlapping_instructions, std::next(overlap)->address);
    }
    return result;
}

auto instruction_at(const function& lifted, u64 address) -> const instruction* {
    const auto found =
        std::ranges::lower_bound(lifted.instructions, address, {}, &instruction::address);
    if (found == lifted.instructions.end() || found->address != address) {
        return nullptr;
    }
    return &*found;
}

}
