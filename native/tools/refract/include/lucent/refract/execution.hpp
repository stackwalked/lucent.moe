#pragma once

#include <expected>

#include <lucent/refract/function.hpp>
#include <lucent/refract/instruction.hpp>
#include <lucent/refract/machine.hpp>

namespace lucent::refract {

enum class fault_kind : u8 {
    // A load or store left the machine's memory region.
    unmapped_memory,
    step_limit,
};

struct fault {
    fault_kind kind = fault_kind::unmapped_memory;
    // The instruction that faulted.
    u64 address = 0;
    // The memory access's address, for unmapped_memory.
    u64 access = 0;

    auto operator==(const fault&) const -> bool = default;
};

// Runs one instruction over the machine and gives the address control goes to next. On a fault the
// machine holds whatever the instruction's earlier operations wrote, as no CPU would leave it.
auto step(const instruction& lifted, machine& state) -> std::expected<u64, fault>;

// Runs from the entry until control leaves the function, and gives the address it leaves to.
auto run(const function& lifted, machine& state, isize step_limit) -> std::expected<u64, fault>;

}
