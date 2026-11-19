#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <Zydis/Encoder.h>
#include <Zydis/SharedTypes.h>

#include <lucent/refract/machine.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {

// The Zydis register for a general-purpose register at a width; bytes are the low byte (spl, not
// ah).
auto zydis_register(gpr reg, width size) -> ZydisRegister;

auto register_operand(ZydisRegister reg) -> ZydisEncoderOperand;

struct memory_reference {
    // ZYDIS_REGISTER_RIP makes displacement an absolute address.
    ZydisRegister base = ZYDIS_REGISTER_NONE;
    ZydisRegister index = ZYDIS_REGISTER_NONE;
    u8 scale = 0;
    i64 displacement = 0;
    width size = width::qword;
};

auto memory_operand(const memory_reference& reference) -> ZydisEncoderOperand;

// A branch target is given as an absolute address.
auto immediate_operand(u64 value) -> ZydisEncoderOperand;

struct encoding {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    std::vector<ZydisEncoderOperand> operands;
    ZydisBranchWidth branch_width = ZYDIS_BRANCH_WIDTH_NONE;
};

// The instruction's bytes for running at address. The encoding must exist.
auto encode(const encoding& request, u64 address) -> std::vector<std::byte>;

}
