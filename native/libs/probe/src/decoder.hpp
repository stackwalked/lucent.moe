#pragma once

#include <array>
#include <vector>

#include <Zydis/DecoderTypes.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe::detail {

struct decoded {
    ZydisDecodedInstruction instruction{};
    std::array<ZydisDecodedOperand, ZYDIS_MAX_OPERAND_COUNT> operands{};
};

// Calls on_instruction(rva, instruction) for each instruction in the range, decoding linearly:
// bytes that aren't an instruction, or are int3 padding, are skipped one at a time.
auto for_each_instruction(
    const module_file& module,
    pe::rva_range range,
    stdx::function_ref<void(u32, const decoded&)> on_instruction
) -> void;

// Each listed function, and each gap between them, as its own range: a listed function starts a
// fresh decode, so a misdecoded gap can't run into the code after it.
auto code_ranges(const module_file& module) -> std::vector<pe::rva_range>;

}
