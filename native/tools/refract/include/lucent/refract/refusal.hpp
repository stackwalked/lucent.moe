#pragma once

#include <string>

namespace lucent::refract {

// Why code was not lifted. The lifter never guesses: anything outside the subset is one of these.
enum class refusal_reason : u8 {
    undecodable,
    // A mnemonic outside the subset; the refusal names it.
    unsupported_instruction,
    // An operand shape outside the subset: a 16-bit push, a pop to memory, a one-operand imul.
    unsupported_operand,
    // lock, rep, repne, bnd, notrack, xacquire or xrelease.
    unsupported_prefix,
    // An fs or gs memory operand: thread-local data, whose base the interpreter doesn't model.
    segment_override,
    address_size_override,
    // ah, ch, dh or bh.
    high_byte_register,
    // A register that is not one of the sixteen general-purpose ones.
    unsupported_register,
    call,
    // A jump through a register or memory, as jump tables and tail calls through a pointer are.
    indirect_branch,
    branch_outside_function,
    // A branch into the middle of an instruction already lifted.
    overlapping_instructions,
    // Control reaches the end of the code without leaving it.
    runs_off_end,
};

struct refusal {
    refusal_reason reason = refusal_reason::undecodable;
    // Of the instruction refused.
    u64 address = 0;
    // Zydis's spelling, empty when the bytes did not decode.
    std::string mnemonic;

    auto operator==(const refusal&) const -> bool = default;
};

}
