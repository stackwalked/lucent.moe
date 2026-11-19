#pragma once

#include <cstddef>
#include <expected>
#include <span>
#include <vector>

#include <lucent/refract/instruction.hpp>
#include <lucent/refract/refusal.hpp>

namespace lucent::refract {

// Every instruction reachable from the entry, sorted by address. Each jump and branch target is
// one of them; control leaves only through a leave.
struct function {
    u64 entry = 0;
    std::vector<instruction> instructions;

    auto operator==(const function&) const -> bool = default;
};

// The function whose bytes are code, running at address and entered there. A branch outside code
// is refused: tail calls are not in the subset.
auto lift_function(std::span<const std::byte> code, u64 address)
    -> std::expected<function, refusal>;

// The instruction at that address, if the function has one.
auto instruction_at(const function& lifted, u64 address) -> const instruction*;

}
