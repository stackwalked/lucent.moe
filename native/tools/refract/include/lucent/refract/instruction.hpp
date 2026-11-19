#pragma once

#include <cstddef>
#include <expected>
#include <span>
#include <variant>
#include <vector>

#include <lucent/refract/operation.hpp>
#include <lucent/refract/refusal.hpp>

namespace lucent::refract {

// Where control goes once an instruction's operations have run.
struct fall_through {
    auto operator==(const fall_through&) const -> bool = default;
};

struct jump {
    u64 target = 0;

    auto operator==(const jump&) const -> bool = default;
};

// To the target when the condition value is nonzero, else to the next instruction.
struct branch {
    value_id condition{};
    u64 target = 0;

    auto operator==(const branch&) const -> bool = default;
};

// Out of the lifted code, to an address computed at run time: a return.
struct leave {
    value_id target{};

    auto operator==(const leave&) const -> bool = default;
};

using flow = std::variant<fall_through, jump, branch, leave>;

// One x86 instruction as IR: its operations run in order, then control goes as next says.
struct instruction {
    u64 address = 0;
    isize length = 0;
    std::vector<operation> operations;
    flow next;

    auto operator==(const instruction&) const -> bool = default;
};

// The instruction at the start of code, which runs at address: rip-relative operands and branch
// targets become absolute addresses from it.
auto lift_instruction(std::span<const std::byte> code, u64 address)
    -> std::expected<instruction, refusal>;

}
