#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <Zydis/Encoder.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/refract/execution.hpp>
#include <lucent/refract/instruction.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/refusal.hpp>
#include <lucent/refract/width.hpp>

#include "assembler.hpp"
#include "native_cpu.hpp"
#include "sampler.hpp"

// Each supported instruction form, encoded by Zydis, run on this CPU and in the interpreter from
// the same random state; registers, memory, the next address and the flags the ISA defines for
// the form must agree.
namespace lucent::refract {
namespace {

constexpr isize encodings_per_form = 8;
constexpr isize states_per_encoding = 16;

enum class operand_kind : u8 {
    reg,
    memory,
    immediate,
    // cl, as a shift count.
    count_register,
    // The immediate 1, as a shift count.
    one,
    // A branch target: the CPU runner's taken label.
    target,
};

struct operand_spec {
    operand_kind kind = operand_kind::reg;
    width size = width::qword;
};

struct form {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    std::vector<operand_spec> operands;
    ZydisBranchWidth branch_width = ZYDIS_BRANCH_WIDTH_NONE;
};

auto bare(ZydisMnemonic mnemonic) -> form {
    return {.mnemonic = mnemonic, .operands = {}, .branch_width = ZYDIS_BRANCH_WIDTH_NONE};
}

auto operand(operand_kind kind, width size) -> operand_spec {
    return {.kind = kind, .size = size};
}

// The value as a signed number of its width, extended to 64 bits.
auto signed_value(u64 value, width size) -> u64 {
    const u64 sign = sign_bit_of(size);
    return ((value & mask_of(size)) ^ sign) - sign;
}

// An encoded instance of a form, and what its random states must respect.
struct instance {
    std::vector<std::byte> code;
    std::optional<gpr> base;
    std::optional<gpr> index;
    // The count an immediate or `1` operand gives a shift.
    std::optional<u64> immediate_count;
    bool has_count_register = false;
    bool is_return = false;
};

constexpr std::array logic_mnemonics{
    ZYDIS_MNEMONIC_AND,
    ZYDIS_MNEMONIC_OR,
    ZYDIS_MNEMONIC_XOR,
    ZYDIS_MNEMONIC_TEST,
};
constexpr std::array shift_mnemonics{ZYDIS_MNEMONIC_SHL, ZYDIS_MNEMONIC_SHR, ZYDIS_MNEMONIC_SAR};
constexpr std::array rotate_mnemonics{ZYDIS_MNEMONIC_ROL, ZYDIS_MNEMONIC_ROR};

auto is_one_of(ZydisMnemonic mnemonic, std::span<const ZydisMnemonic> set) -> bool {
    return std::ranges::contains(set, mnemonic);
}

// Zydis's encoder reads every immediate as signed: a byte of 0xff is -1, which fits.
auto immediate_for(const form& tested, const operand_spec& spec, sampler& draw) -> u64 {
    const bool is_movabs = tested.mnemonic == ZYDIS_MNEMONIC_MOV
                           && tested.operands.front().kind == operand_kind::reg
                           && spec.size == width::qword;
    if (is_one_of(tested.mnemonic, shift_mnemonics)
        || is_one_of(tested.mnemonic, rotate_mnemonics)) {
        return draw.below(70);
    }
    if (tested.mnemonic == ZYDIS_MNEMONIC_RET) {
        return draw.below(0x1'0000);
    }
    if (is_movabs) {
        return draw.number();
    }
    // Only movabs takes a full qword; the rest sign-extend a dword.
    return signed_value(draw.number(), spec.size == width::qword ? width::dword : spec.size);
}

struct memory_choice {
    ZydisEncoderOperand operand{};
    std::optional<gpr> base;
    std::optional<gpr> index;
};

// rip-relative a fifth of the time, else a base, and half the time an index, which the random
// state then points into the machine's memory.
auto memory_for(const native_cpu& cpu, width size, sampler& draw) -> memory_choice {
    if (draw.below(5) == 0) {
        const u64 target = cpu.memory_base() + 1024 + draw.below(2048);
        return {
            .operand = memory_operand({
                .base = ZYDIS_REGISTER_RIP,
                .index = ZYDIS_REGISTER_NONE,
                .scale = 0,
                .displacement = std::bit_cast<i64>(target),
                .size = size,
            }),
            .base = std::nullopt,
            .index = std::nullopt,
        };
    }
    const gpr base = draw.reg();
    memory_reference reference{
        .base = zydis_register(base, width::qword),
        .index = ZYDIS_REGISTER_NONE,
        .scale = 0,
        .displacement = std::bit_cast<i64>(draw.below(256)) - 128,
        .size = size,
    };
    std::optional<gpr> index;
    if (draw.below(2) == 0) {
        gpr chosen = draw.reg();
        while (chosen == gpr::rsp || chosen == base) {
            chosen = draw.reg();
        }
        index = chosen;
        reference.index = zydis_register(chosen, width::qword);
        reference.scale = narrow<u8>(u64{1} << draw.below(4));
    }
    return {.operand = memory_operand(reference), .base = base, .index = index};
}

auto instantiate(const native_cpu& cpu, const form& tested, sampler& draw) -> instance {
    instance made{
        .code = {},
        .base = std::nullopt,
        .index = std::nullopt,
        .immediate_count = std::nullopt,
        .has_count_register = false,
        .is_return = tested.mnemonic == ZYDIS_MNEMONIC_RET,
    };
    encoding request{
        .mnemonic = tested.mnemonic,
        .operands = {},
        .branch_width = tested.branch_width,
    };
    for (const operand_spec& spec : tested.operands) {
        switch (spec.kind) {
        case operand_kind::reg:
            request.operands.push_back(register_operand(zydis_register(draw.reg(), spec.size)));
            break;
        case operand_kind::memory: {
            const memory_choice chosen = memory_for(cpu, spec.size, draw);
            made.base = chosen.base;
            made.index = chosen.index;
            request.operands.push_back(chosen.operand);
            break;
        }
        case operand_kind::immediate:
            made.immediate_count = immediate_for(tested, spec, draw);
            request.operands.push_back(immediate_operand(*made.immediate_count));
            break;
        case operand_kind::count_register:
            made.has_count_register = true;
            request.operands.push_back(register_operand(ZYDIS_REGISTER_CL));
            break;
        case operand_kind::one:
            made.immediate_count = 1;
            request.operands.push_back(immediate_operand(1));
            break;
        case operand_kind::target:
            request.operands.push_back(immediate_operand(cpu.taken_address()));
            break;
        }
    }
    made.code = encode(request, cpu.instruction_address());
    return made;
}

// Registers and flags at random; rsp, and the registers a memory operand goes through, inside the
// machine's memory so every access lands there. A return finds the taken label on the stack.
auto random_state(const native_cpu& cpu, const instance& made, sampler& draw) -> machine {
    machine state{
        .registers = {},
        .flags = draw.any() & arithmetic_flags,
        .memory = {.base = cpu.memory_base(), .bytes = std::vector<u8>(native_cpu::memory_size)},
    };
    for (u64& value : state.registers) {
        value = draw.number();
    }
    for (u8& byte : state.memory.bytes) {
        byte = narrow<u8>(draw.below(256));
    }
    const auto set = [&](gpr reg, u64 value) {
        state.registers.at(std::to_underlying(reg)) = value;
    };
    const u64 stack = cpu.memory_base() + 2048 + (8 * draw.below(64));
    set(gpr::rsp, stack);
    if (made.base) {
        set(*made.base, cpu.memory_base() + 1024 + draw.below(1024));
    }
    if (made.index) {
        set(*made.index, draw.below(32));
    }
    if (made.has_count_register && draw.below(4) != 0) {
        const u64 rcx = state.registers.at(std::to_underlying(gpr::rcx));
        set(gpr::rcx, (rcx & ~u64{0xff}) | draw.below(72));
    }
    if (made.is_return) {
        write(state.memory, {.address = stack, .size = width::qword}, cpu.taken_address());
    }
    return state;
}

auto operand_width_of(const form& tested) -> width {
    return tested.operands.empty() ? width::qword : tested.operands.front().size;
}

// The flags Intel SDM vol. 2 defines after the form ran ("Flags Affected"); a flag the instruction
// doesn't touch is defined as the one it had. Written from the manual, not from the interpreter.
auto defined_flags(const form& tested, const instance& made, const machine& before) -> u64 {
    const width size = operand_width_of(tested);
    const u64 adjust = mask_of(flag::adjust);
    const u64 count_mask = size == width::qword ? 0x3f : 0x1f;
    const u64 count =
        made.immediate_count.value_or(before.registers.at(std::to_underlying(gpr::rcx)))
        & count_mask;
    const ZydisMnemonic mnemonic = tested.mnemonic;
    if (is_one_of(mnemonic, logic_mnemonics)) {
        return arithmetic_flags & ~adjust;
    }
    if (mnemonic == ZYDIS_MNEMONIC_IMUL) {
        return mask_of(flag::carry) | mask_of(flag::overflow);
    }
    if (is_one_of(mnemonic, rotate_mnemonics)) {
        return count <= 1 ? arithmetic_flags : arithmetic_flags & ~mask_of(flag::overflow);
    }
    if (!is_one_of(mnemonic, shift_mnemonics) || count == 0) {
        return arithmetic_flags;
    }
    u64 defined = arithmetic_flags & ~adjust;
    if (count != 1) {
        defined &= ~mask_of(flag::overflow);
    }
    // SHL and SHR leave the carry undefined once the count reaches the operand's width, which
    // after masking only bytes and words can.
    if (count >= bits_of(size) && mnemonic != ZYDIS_MNEMONIC_SAR) {
        defined &= ~mask_of(flag::carry);
    }
    return defined;
}

auto hex_of(std::span<const std::byte> code) -> std::string {
    std::string text;
    for (const std::byte each : code) {
        text += std::format("{:02x} ", std::to_integer<u8>(each));
    }
    return text;
}

auto difference(const machine& native, const machine& interpreted, u64 defined)
    -> std::optional<std::string> {
    for (isize i = 0; i < gpr_count; ++i) {
        const u64 expected = native.registers.at(narrow<usize>(i));
        const u64 actual = interpreted.registers.at(narrow<usize>(i));
        if (expected != actual) {
            return std::format("register {}: cpu {:#x}, interpreter {:#x}", i, expected, actual);
        }
    }
    if ((native.flags & defined) != (interpreted.flags & defined)) {
        return std::format(
            "flags under {:#x}: cpu {:#x}, interpreter {:#x}",
            defined,
            native.flags & defined,
            interpreted.flags & defined
        );
    }
    if (native.memory != interpreted.memory) {
        return std::string{"memory"};
    }
    return std::nullopt;
}

// One encoding of a form, lifted.
struct trial {
    form tested;
    instance made;
    instruction lifted;
};

// How the CPU and the interpreter disagree from one random state, if they do.
auto disagreement(native_cpu& cpu, const trial& each, sampler& draw) -> std::optional<std::string> {
    const machine before = random_state(cpu, each.made, draw);
    machine native = before;
    const u64 native_next = cpu.run(each.made.code, native);
    machine interpreted = before;
    const std::expected<u64, fault> next = step(each.lifted, interpreted);
    if (!next) {
        return std::string{"faulted in the interpreter"};
    }
    if (*next != native_next) {
        return std::format("went to {:#x}, not {:#x}", *next, native_next);
    }
    return difference(native, interpreted, defined_flags(each.tested, each.made, before));
}

auto describe(const form& tested, const instance& made) -> std::string {
    return std::format("{} [{}]", ZydisMnemonicGetString(tested.mnemonic), hex_of(made.code));
}

// Runs the form's encodings from random states on the CPU and in the interpreter. The first
// disagreement fails the check and ends the form.
auto check_form(native_cpu& cpu, const form& tested, sampler& draw) -> void {
    for (isize e = 0; e < encodings_per_form; ++e) {
        instance made = instantiate(cpu, tested, draw);
        std::expected<instruction, refusal> lifted =
            lift_instruction(made.code, cpu.instruction_address());
        if (!lifted) {
            FAIL_CHECK(describe(tested, made) << " was refused");
            return;
        }
        const trial each{
            .tested = tested,
            .made = std::move(made),
            .lifted = *std::move(lifted),
        };
        for (isize s = 0; s < states_per_encoding; ++s) {
            const std::optional<std::string> found = disagreement(cpu, each, draw);
            if (found) {
                FAIL_CHECK(describe(each.tested, each.made) << ": " << *found);
                return;
            }
        }
    }
}

auto check_forms(std::span<const form> forms, u64 seed) -> void {
    native_cpu cpu;
    sampler draw{seed};
    for (const form& tested : forms) {
        check_form(cpu, tested, draw);
    }
}

using shape = std::vector<operand_kind>;

// Every mnemonic in every shape at every width, all operands of that width but a cl count.
auto forms_of(
    std::span<const ZydisMnemonic> mnemonics,
    std::span<const shape> shapes,
    std::span<const width> widths
) -> std::vector<form> {
    std::vector<form> forms;
    forms.reserve(mnemonics.size() * shapes.size() * widths.size());
    for (const ZydisMnemonic mnemonic : mnemonics) {
        for (const shape& kinds : shapes) {
            for (const width size : widths) {
                form made = bare(mnemonic);
                for (const operand_kind kind : kinds) {
                    const bool is_count = kind == operand_kind::count_register;
                    made.operands.push_back(operand(kind, is_count ? width::byte : size));
                }
                forms.push_back(std::move(made));
            }
        }
    }
    return forms;
}

constexpr std::array all_widths{width::byte, width::word, width::dword, width::qword};
constexpr std::array wide_widths{width::word, width::dword, width::qword};

TEST_CASE("add, subtract, compare and the logic operations match the CPU") {
    constexpr std::array arithmetic{
        ZYDIS_MNEMONIC_ADD,
        ZYDIS_MNEMONIC_ADC,
        ZYDIS_MNEMONIC_SUB,
        ZYDIS_MNEMONIC_SBB,
        ZYDIS_MNEMONIC_CMP,
        ZYDIS_MNEMONIC_AND,
        ZYDIS_MNEMONIC_OR,
        ZYDIS_MNEMONIC_XOR,
    };
    const std::array shapes{
        shape{operand_kind::reg, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::memory},
        shape{operand_kind::memory, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::immediate},
        shape{operand_kind::memory, operand_kind::immediate},
    };
    check_forms(forms_of(arithmetic, shapes, all_widths), 0x5eed'0001);

    constexpr std::array test{ZYDIS_MNEMONIC_TEST};
    const std::array test_shapes{
        shape{operand_kind::reg, operand_kind::reg},
        shape{operand_kind::memory, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::immediate},
        shape{operand_kind::memory, operand_kind::immediate},
    };
    check_forms(forms_of(test, test_shapes, all_widths), 0x5eed'0002);
}

TEST_CASE("increment, decrement, negate and not match the CPU") {
    constexpr std::array unary{
        ZYDIS_MNEMONIC_INC,
        ZYDIS_MNEMONIC_DEC,
        ZYDIS_MNEMONIC_NEG,
        ZYDIS_MNEMONIC_NOT,
    };
    const std::array shapes{shape{operand_kind::reg}, shape{operand_kind::memory}};
    check_forms(forms_of(unary, shapes, all_widths), 0x5eed'0003);
}

TEST_CASE("signed multiply matches the CPU in its two- and three-operand forms") {
    constexpr std::array multiply{ZYDIS_MNEMONIC_IMUL};
    const std::array shapes{
        shape{operand_kind::reg, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::memory},
        shape{operand_kind::reg, operand_kind::reg, operand_kind::immediate},
        shape{operand_kind::reg, operand_kind::memory, operand_kind::immediate},
    };
    check_forms(forms_of(multiply, shapes, wide_widths), 0x5eed'0004);
}

TEST_CASE("shifts and rotates match the CPU on the flags the ISA defines for their count") {
    constexpr std::array shifts{
        ZYDIS_MNEMONIC_SHL,
        ZYDIS_MNEMONIC_SHR,
        ZYDIS_MNEMONIC_SAR,
        ZYDIS_MNEMONIC_ROL,
        ZYDIS_MNEMONIC_ROR,
    };
    const std::array shapes{
        shape{operand_kind::reg, operand_kind::immediate},
        shape{operand_kind::memory, operand_kind::immediate},
        shape{operand_kind::reg, operand_kind::count_register},
        shape{operand_kind::memory, operand_kind::count_register},
        shape{operand_kind::reg, operand_kind::one},
    };
    check_forms(forms_of(shifts, shapes, all_widths), 0x5eed'0005);
}

auto two_operand(ZydisMnemonic mnemonic, operand_spec target, operand_spec source) -> form {
    form made = bare(mnemonic);
    made.operands = {target, source};
    return made;
}

auto extension_forms() -> std::vector<form> {
    struct extension_shape {
        width target = width::qword;
        width source = width::byte;
    };

    constexpr std::array shapes{
        extension_shape{.target = width::word, .source = width::byte},
        extension_shape{.target = width::dword, .source = width::byte},
        extension_shape{.target = width::qword, .source = width::byte},
        extension_shape{.target = width::dword, .source = width::word},
        extension_shape{.target = width::qword, .source = width::word},
    };
    std::vector<form> forms;
    for (const ZydisMnemonic mnemonic : {ZYDIS_MNEMONIC_MOVZX, ZYDIS_MNEMONIC_MOVSX}) {
        for (const extension_shape each : shapes) {
            const operand_spec target = operand(operand_kind::reg, each.target);
            forms.push_back(two_operand(mnemonic, target, operand(operand_kind::reg, each.source)));
            forms.push_back(
                two_operand(mnemonic, target, operand(operand_kind::memory, each.source))
            );
        }
    }
    const operand_spec qword_target = operand(operand_kind::reg, width::qword);
    forms.push_back(
        two_operand(ZYDIS_MNEMONIC_MOVSXD, qword_target, operand(operand_kind::reg, width::dword))
    );
    forms.push_back(two_operand(
        ZYDIS_MNEMONIC_MOVSXD, qword_target, operand(operand_kind::memory, width::dword)
    ));
    return forms;
}

TEST_CASE("moves, zero and sign extensions and lea match the CPU") {
    constexpr std::array move{ZYDIS_MNEMONIC_MOV};
    const std::array shapes{
        shape{operand_kind::reg, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::memory},
        shape{operand_kind::memory, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::immediate},
        shape{operand_kind::memory, operand_kind::immediate},
    };
    check_forms(forms_of(move, shapes, all_widths), 0x5eed'0006);
    check_forms(extension_forms(), 0x5eed'0007);

    // Zydis's encoder takes lea's memory operand at the address size, whatever the destination.
    const operand_spec address = operand(operand_kind::memory, width::qword);
    const std::array addresses{
        two_operand(ZYDIS_MNEMONIC_LEA, operand(operand_kind::reg, width::word), address),
        two_operand(ZYDIS_MNEMONIC_LEA, operand(operand_kind::reg, width::dword), address),
        two_operand(ZYDIS_MNEMONIC_LEA, operand(operand_kind::reg, width::qword), address),
    };
    check_forms(addresses, 0x5eed'0008);
}

TEST_CASE("push, pop and ret move the stack as the CPU does") {
    constexpr std::array qword_only{width::qword};
    constexpr std::array push{ZYDIS_MNEMONIC_PUSH};
    const std::array push_shapes{
        shape{operand_kind::reg},
        shape{operand_kind::memory},
        shape{operand_kind::immediate},
    };
    check_forms(forms_of(push, push_shapes, qword_only), 0x5eed'0009);

    constexpr std::array pop{ZYDIS_MNEMONIC_POP};
    const std::array pop_shapes{shape{operand_kind::reg}};
    check_forms(forms_of(pop, pop_shapes, qword_only), 0x5eed'000a);

    form released = bare(ZYDIS_MNEMONIC_RET);
    released.operands = {operand(operand_kind::immediate, width::word)};
    const std::array returns{bare(ZYDIS_MNEMONIC_RET), released};
    check_forms(returns, 0x5eed'000b);
}

constexpr std::array conditional_moves{
    ZYDIS_MNEMONIC_CMOVO,
    ZYDIS_MNEMONIC_CMOVNO,
    ZYDIS_MNEMONIC_CMOVB,
    ZYDIS_MNEMONIC_CMOVNB,
    ZYDIS_MNEMONIC_CMOVZ,
    ZYDIS_MNEMONIC_CMOVNZ,
    ZYDIS_MNEMONIC_CMOVBE,
    ZYDIS_MNEMONIC_CMOVNBE,
    ZYDIS_MNEMONIC_CMOVS,
    ZYDIS_MNEMONIC_CMOVNS,
    ZYDIS_MNEMONIC_CMOVP,
    ZYDIS_MNEMONIC_CMOVNP,
    ZYDIS_MNEMONIC_CMOVL,
    ZYDIS_MNEMONIC_CMOVNL,
    ZYDIS_MNEMONIC_CMOVLE,
    ZYDIS_MNEMONIC_CMOVNLE,
};

constexpr std::array sets{
    ZYDIS_MNEMONIC_SETO,
    ZYDIS_MNEMONIC_SETNO,
    ZYDIS_MNEMONIC_SETB,
    ZYDIS_MNEMONIC_SETNB,
    ZYDIS_MNEMONIC_SETZ,
    ZYDIS_MNEMONIC_SETNZ,
    ZYDIS_MNEMONIC_SETBE,
    ZYDIS_MNEMONIC_SETNBE,
    ZYDIS_MNEMONIC_SETS,
    ZYDIS_MNEMONIC_SETNS,
    ZYDIS_MNEMONIC_SETP,
    ZYDIS_MNEMONIC_SETNP,
    ZYDIS_MNEMONIC_SETL,
    ZYDIS_MNEMONIC_SETNL,
    ZYDIS_MNEMONIC_SETLE,
    ZYDIS_MNEMONIC_SETNLE,
};

constexpr std::array branches{
    ZYDIS_MNEMONIC_JO,
    ZYDIS_MNEMONIC_JNO,
    ZYDIS_MNEMONIC_JB,
    ZYDIS_MNEMONIC_JNB,
    ZYDIS_MNEMONIC_JZ,
    ZYDIS_MNEMONIC_JNZ,
    ZYDIS_MNEMONIC_JBE,
    ZYDIS_MNEMONIC_JNBE,
    ZYDIS_MNEMONIC_JS,
    ZYDIS_MNEMONIC_JNS,
    ZYDIS_MNEMONIC_JP,
    ZYDIS_MNEMONIC_JNP,
    ZYDIS_MNEMONIC_JL,
    ZYDIS_MNEMONIC_JNL,
    ZYDIS_MNEMONIC_JLE,
    ZYDIS_MNEMONIC_JNLE,
    ZYDIS_MNEMONIC_JMP,
};

// Each branch in its rel8 and its rel32 encoding.
auto branch_forms() -> std::vector<form> {
    constexpr std::array reaches{ZYDIS_BRANCH_WIDTH_8, ZYDIS_BRANCH_WIDTH_32};
    std::vector<form> forms;
    forms.reserve(branches.size() * reaches.size());
    for (const ZydisMnemonic mnemonic : branches) {
        for (const ZydisBranchWidth reach : reaches) {
            forms.push_back({
                .mnemonic = mnemonic,
                .operands = {operand(operand_kind::target, width::qword)},
                .branch_width = reach,
            });
        }
    }
    return forms;
}

TEST_CASE("conditional moves, sets and branches decide every condition as the CPU does") {
    const std::array move_shapes{
        shape{operand_kind::reg, operand_kind::reg},
        shape{operand_kind::reg, operand_kind::memory},
    };
    check_forms(forms_of(conditional_moves, move_shapes, wide_widths), 0x5eed'000c);

    constexpr std::array byte_only{width::byte};
    const std::array set_shapes{shape{operand_kind::reg}, shape{operand_kind::memory}};
    check_forms(forms_of(sets, set_shapes, byte_only), 0x5eed'000d);

    check_forms(branch_forms(), 0x5eed'000e);
}

TEST_CASE("the accumulator sign extensions and nop match the CPU") {
    const std::array forms{
        bare(ZYDIS_MNEMONIC_CBW),
        bare(ZYDIS_MNEMONIC_CWDE),
        bare(ZYDIS_MNEMONIC_CDQE),
        bare(ZYDIS_MNEMONIC_CWD),
        bare(ZYDIS_MNEMONIC_CDQ),
        bare(ZYDIS_MNEMONIC_CQO),
        bare(ZYDIS_MNEMONIC_NOP),
    };
    check_forms(forms, 0x5eed'000f);
}

}
}
