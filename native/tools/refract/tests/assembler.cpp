#include "assembler.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <utility>
#include <vector>

#include <Zycore/Status.h>
#include <Zycore/Types.h>
#include <Zydis/Encoder.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/narrow.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {

auto zydis_register(gpr reg, width size) -> ZydisRegister {
    const i32 id = std::to_underlying(reg);
    switch (size) {
    // Zydis lists AL to BL, then AH to BH, then SPL to DIL and R8B to R15B: past the first four,
    // the low bytes sit four further on.
    case width::byte:
        return static_cast<ZydisRegister>(
            id < 4 ? ZYDIS_REGISTER_AL + id : ZYDIS_REGISTER_AL + id + 4
        );
    case width::word:
        return static_cast<ZydisRegister>(ZYDIS_REGISTER_AX + id);
    case width::dword:
        return static_cast<ZydisRegister>(ZYDIS_REGISTER_EAX + id);
    case width::qword:
        return static_cast<ZydisRegister>(ZYDIS_REGISTER_RAX + id);
    }
    LUCENT_UNREACHABLE();
}

auto register_operand(ZydisRegister reg) -> ZydisEncoderOperand {
    ZydisEncoderOperand operand{};
    operand.type = ZYDIS_OPERAND_TYPE_REGISTER;
    operand.reg.value = reg;
    return operand;
}

auto memory_operand(const memory_reference& reference) -> ZydisEncoderOperand {
    ZydisEncoderOperand operand{};
    operand.type = ZYDIS_OPERAND_TYPE_MEMORY;
    operand.mem.base = reference.base;
    operand.mem.index = reference.index;
    operand.mem.scale = reference.scale;
    operand.mem.displacement = reference.displacement;
    operand.mem.size = std::to_underlying(reference.size);
    return operand;
}

auto immediate_operand(u64 value) -> ZydisEncoderOperand {
    ZydisEncoderOperand operand{};
    operand.type = ZYDIS_OPERAND_TYPE_IMMEDIATE;
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access): Zydis reads u or s as the same bits.
    operand.imm.u = value;
    return operand;
}

auto encode(const encoding& request, u64 address) -> std::vector<std::byte> {
    ZydisEncoderRequest zydis{};
    zydis.machine_mode = ZYDIS_MACHINE_MODE_LONG_64;
    zydis.mnemonic = request.mnemonic;
    zydis.branch_width = request.branch_width;
    zydis.operand_count = narrow<ZyanU8>(request.operands.size());
    std::ranges::copy(request.operands, std::begin(zydis.operands));
    std::array<std::byte, ZYDIS_MAX_INSTRUCTION_LENGTH> bytes{};
    ZyanUSize length = bytes.size();
    const ZyanStatus status =
        ZydisEncoderEncodeInstructionAbsolute(&zydis, bytes.data(), &length, address);
    LUCENT_INVARIANT(ZYAN_SUCCESS(status));
    return {bytes.begin(), bytes.begin() + narrow<isize>(length)};
}

}
