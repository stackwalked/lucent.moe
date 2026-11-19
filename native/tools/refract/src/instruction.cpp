#include <lucent/refract/instruction.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <utility>
#include <variant>
#include <vector>

#include <Zycore/Status.h>
#include <Zydis/Decoder.h>
#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>
#include <Zydis/Utils.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/operation.hpp>
#include <lucent/refract/refusal.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {
namespace {

struct decoded {
    ZydisDecodedInstruction instruction{};
    std::array<ZydisDecodedOperand, ZYDIS_MAX_OPERAND_COUNT> operands{};
};

auto decode(std::span<const std::byte> code) -> std::optional<decoded> {
    ZydisDecoder decoder{};
    const ZyanStatus initialized =
        ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
    LUCENT_INVARIANT(ZYAN_SUCCESS(initialized));
    decoded result{};
    const ZyanStatus status = ZydisDecoderDecodeFull(
        &decoder, code.data(), code.size(), &result.instruction, result.operands.data()
    );
    if (!ZYAN_SUCCESS(status)) {
        return std::nullopt;
    }
    return result;
}

// build: Zydis 4.1 (vcpkg); a decoded operand's reg, mem and imm share a union that operand.type
// tags, and an immediate's u and s another.
// breaks: a member read under the wrong type is another operand kind's bytes.
// NOLINTBEGIN(cppcoreguidelines-pro-type-union-access): each read checks the tag first.
auto register_of(const ZydisDecodedOperand& operand) -> ZydisRegister {
    LUCENT_INVARIANT(operand.type == ZYDIS_OPERAND_TYPE_REGISTER);
    return operand.reg.value;
}

auto memory_of(const ZydisDecodedOperand& operand) -> const ZydisDecodedOperandMem& {
    LUCENT_INVARIANT(operand.type == ZYDIS_OPERAND_TYPE_MEMORY);
    return operand.mem;
}

// Zydis sign-extends a signed immediate to 64 bits, so u holds the value either way.
auto immediate_of(const ZydisDecodedOperand& operand) -> u64 {
    LUCENT_INVARIANT(operand.type == ZYDIS_OPERAND_TYPE_IMMEDIATE);
    return operand.imm.value.u;
}

auto is_relative(const ZydisDecodedOperand& operand) -> bool {
    return operand.type == ZYDIS_OPERAND_TYPE_IMMEDIATE && operand.imm.is_relative != 0;
}

// NOLINTEND(cppcoreguidelines-pro-type-union-access)

struct register_location {
    gpr reg = gpr::rax;
    width size = width::qword;
};

struct memory_location {
    value_id address{};
    width size = width::qword;
};

struct immediate_location {
    u64 value = 0;
};

using location = std::variant<register_location, memory_location, immediate_location>;

// Prefixes that change what an instruction in the subset means, or that only make sense outside
// it.
constexpr ZydisInstructionAttributes refused_prefixes = ZYDIS_ATTRIB_HAS_LOCK
                                                        | ZYDIS_ATTRIB_HAS_REP
                                                        | ZYDIS_ATTRIB_HAS_REPE
                                                        | ZYDIS_ATTRIB_HAS_REPNE
                                                        | ZYDIS_ATTRIB_HAS_BND
                                                        | ZYDIS_ATTRIB_HAS_XACQUIRE
                                                        | ZYDIS_ATTRIB_HAS_XRELEASE
                                                        | ZYDIS_ATTRIB_HAS_NOTRACK;

// How the lifter treats a mnemonic of the subset.
enum class family : u8 {
    move,
    zero_extend,
    sign_extend,
    load_address,
    push,
    pop,
    // The result written back with its flags: add, adc, sub, sbb, and, or, xor.
    arithmetic,
    // Only the flags kept: cmp and test.
    compare,
    // inc and dec: arithmetic with 1.
    step,
    negate,
    invert,
    multiply,
    shift,
    conditional_move,
    set,
    branch,
    jump,
    ret,
    call,
    nop,
    widen_accumulator,
    sign_into_data,
};

struct mnemonic_rule {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    family kind = family::nop;
    operator_kind op = operator_kind::add;
    flag_rule flags = flag_rule::logic;
};

// The subset. Anything not listed is refused.
constexpr std::array mnemonic_rules{
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_MOV, .kind = family::move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_MOVZX, .kind = family::zero_extend},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_MOVSX, .kind = family::sign_extend},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_MOVSXD, .kind = family::sign_extend},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_LEA, .kind = family::load_address},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_PUSH, .kind = family::push},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_POP, .kind = family::pop},
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_ADD,
        .kind = family::arithmetic,
        .op = operator_kind::add,
        .flags = flag_rule::add,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_ADC,
        .kind = family::arithmetic,
        .op = operator_kind::add,
        .flags = flag_rule::add_with_carry,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_SUB,
        .kind = family::arithmetic,
        .op = operator_kind::subtract,
        .flags = flag_rule::subtract,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_SBB,
        .kind = family::arithmetic,
        .op = operator_kind::subtract,
        .flags = flag_rule::subtract_with_borrow,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_AND,
        .kind = family::arithmetic,
        .op = operator_kind::bit_and,
        .flags = flag_rule::logic,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_OR,
        .kind = family::arithmetic,
        .op = operator_kind::bit_or,
        .flags = flag_rule::logic,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_XOR,
        .kind = family::arithmetic,
        .op = operator_kind::bit_xor,
        .flags = flag_rule::logic,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_CMP,
        .kind = family::compare,
        .op = operator_kind::subtract,
        .flags = flag_rule::subtract,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_TEST,
        .kind = family::compare,
        .op = operator_kind::bit_and,
        .flags = flag_rule::logic,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_INC,
        .kind = family::step,
        .op = operator_kind::add,
        .flags = flag_rule::increment,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_DEC,
        .kind = family::step,
        .op = operator_kind::subtract,
        .flags = flag_rule::decrement,
    },
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_NEG, .kind = family::negate},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_NOT, .kind = family::invert},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_IMUL, .kind = family::multiply},
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_SHL,
        .kind = family::shift,
        .op = operator_kind::shift_left,
        .flags = flag_rule::shift_left,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_SHR,
        .kind = family::shift,
        .op = operator_kind::shift_right,
        .flags = flag_rule::shift_right,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_SAR,
        .kind = family::shift,
        .op = operator_kind::shift_right_arithmetic,
        .flags = flag_rule::shift_right_arithmetic,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_ROL,
        .kind = family::shift,
        .op = operator_kind::rotate_left,
        .flags = flag_rule::rotate_left,
    },
    mnemonic_rule{
        .mnemonic = ZYDIS_MNEMONIC_ROR,
        .kind = family::shift,
        .op = operator_kind::rotate_right,
        .flags = flag_rule::rotate_right,
    },
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVO, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNO, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVB, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNB, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVZ, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNZ, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVBE, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNBE, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVS, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNS, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVP, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNP, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVL, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNL, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVLE, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNLE, .kind = family::conditional_move},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETO, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNO, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETB, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNB, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETZ, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNZ, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETBE, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNBE, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETS, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNS, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETP, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNP, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETL, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNL, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETLE, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_SETNLE, .kind = family::set},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JO, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNO, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JB, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNB, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JZ, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNZ, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JBE, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNBE, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JS, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNS, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JP, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNP, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JL, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNL, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JLE, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JNLE, .kind = family::branch},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_JMP, .kind = family::jump},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_RET, .kind = family::ret},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CALL, .kind = family::call},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_NOP, .kind = family::nop},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CBW, .kind = family::widen_accumulator},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CWDE, .kind = family::widen_accumulator},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CDQE, .kind = family::widen_accumulator},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CWD, .kind = family::sign_into_data},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CDQ, .kind = family::sign_into_data},
    mnemonic_rule{.mnemonic = ZYDIS_MNEMONIC_CQO, .kind = family::sign_into_data},
};

auto rule_of(ZydisMnemonic mnemonic) -> std::optional<mnemonic_rule> {
    const auto found = std::ranges::find(mnemonic_rules, mnemonic, &mnemonic_rule::mnemonic);
    if (found == mnemonic_rules.end()) {
        return std::nullopt;
    }
    return *found;
}

// The IR of one decoded instruction, built operation by operation.
class lifter final {
public:
    lifter(const decoded& source, u64 address)
        : m_source{source}
        , m_address{address} {}

    auto lift() -> std::expected<instruction, refusal> {
        if ((m_source.instruction.attributes & refused_prefixes) != 0) {
            return refuse(refusal_reason::unsupported_prefix);
        }
        const flow next = LUCENT_TRY(lift_mnemonic());
        return instruction{
            .address = m_address,
            .length = m_source.instruction.length,
            .operations = std::move(m_operations),
            .next = next,
        };
    }

private:
    decoded m_source;
    u64 m_address = 0;
    std::vector<operation> m_operations;

    auto refuse(refusal_reason reason) const -> std::unexpected<refusal> {
        return std::unexpected{refusal{
            .reason = reason,
            .address = m_address,
            .mnemonic = ZydisMnemonicGetString(m_source.instruction.mnemonic),
        }};
    }

    auto next_address() const -> u64 {
        return m_address + m_source.instruction.length;
    }

    auto operand_width() const -> width {
        return width_from_bits(m_source.instruction.operand_width).value_or(width::qword);
    }

    auto visible_operands() const -> isize {
        return m_source.instruction.operand_count_visible;
    }

    auto operand(isize index) const -> const ZydisDecodedOperand& {
        return m_source.operands.at(narrow<usize>(index));
    }

    static auto width_from_bits(u32 bits) -> std::optional<width> {
        switch (bits) {
        case 8:
            return width::byte;
        case 16:
            return width::word;
        case 32:
            return width::dword;
        case 64:
            return width::qword;
        default:
            return std::nullopt;
        }
    }

    // Every operation gets an index, whether or not it produces a value; no instruction comes
    // near 256 of them.
    auto emit(const operation& made) -> value_id {
        append(made);
        return value_id{narrow<u8>(m_operations.size() - 1)};
    }

    auto append(const operation& made) -> void {
        LUCENT_INVARIANT(m_operations.size() < 256);
        m_operations.push_back(made);
    }

    auto number(u64 value) -> value_id {
        return emit(constant{.value = value});
    }

    auto gpr_of(ZydisRegister reg) const -> std::expected<gpr, refusal> {
        if (reg >= ZYDIS_REGISTER_AH && reg <= ZYDIS_REGISTER_BH) {
            return refuse(refusal_reason::high_byte_register);
        }
        const ZydisRegisterClass group = ZydisRegisterGetClass(reg);
        if (group != ZYDIS_REGCLASS_GPR8
            && group != ZYDIS_REGCLASS_GPR16
            && group != ZYDIS_REGCLASS_GPR32
            && group != ZYDIS_REGCLASS_GPR64) {
            return refuse(refusal_reason::unsupported_register);
        }
        const ZydisRegister enclosing =
            ZydisRegisterGetLargestEnclosing(ZYDIS_MACHINE_MODE_LONG_64, reg);
        // Zydis lists RAX to R15 in encoding order, the order gpr has.
        return gpr{narrow<u8>(enclosing - ZYDIS_REGISTER_RAX)};
    }

    auto address_of(const ZydisDecodedOperand& source) -> std::expected<value_id, refusal> {
        const ZydisDecodedOperandMem& memory = memory_of(source);
        if (memory.type != ZYDIS_MEMOP_TYPE_MEM && memory.type != ZYDIS_MEMOP_TYPE_AGEN) {
            return refuse(refusal_reason::unsupported_operand);
        }
        if (memory.segment == ZYDIS_REGISTER_FS || memory.segment == ZYDIS_REGISTER_GS) {
            return refuse(refusal_reason::segment_override);
        }
        if (m_source.instruction.address_width != 64) {
            return refuse(refusal_reason::address_size_override);
        }
        const u64 displacement = std::bit_cast<u64>(memory.disp.value);
        if (memory.base == ZYDIS_REGISTER_RIP) {
            return number(next_address() + displacement);
        }
        value_id address = number(displacement);
        if (memory.base != ZYDIS_REGISTER_NONE) {
            const gpr base = LUCENT_TRY(gpr_of(memory.base));
            const value_id base_value = emit(read_register{.source = base, .size = width::qword});
            address = add(base_value, address);
        }
        if (memory.index != ZYDIS_REGISTER_NONE) {
            const gpr index = LUCENT_TRY(gpr_of(memory.index));
            const value_id index_value = emit(read_register{.source = index, .size = width::qword});
            const value_id scaled = emit(
                compute{
                    .kind = operator_kind::multiply,
                    .size = width::qword,
                    .lhs = index_value,
                    .rhs = number(memory.scale),
                }
            );
            address = add(address, scaled);
        }
        return address;
    }

    auto add(value_id lhs, value_id rhs) -> value_id {
        return emit(
            compute{
                .kind = operator_kind::add,
                .size = width::qword,
                .lhs = lhs,
                .rhs = rhs,
            }
        );
    }

    auto locate(isize index) -> std::expected<location, refusal> {
        const ZydisDecodedOperand& source = operand(index);
        const std::optional<width> size = width_from_bits(source.size);
        if (source.type == ZYDIS_OPERAND_TYPE_REGISTER) {
            const gpr reg = LUCENT_TRY(gpr_of(register_of(source)));
            if (!size) {
                return refuse(refusal_reason::unsupported_operand);
            }
            return register_location{.reg = reg, .size = *size};
        }
        if (source.type == ZYDIS_OPERAND_TYPE_MEMORY) {
            if (!size && memory_of(source).type != ZYDIS_MEMOP_TYPE_AGEN) {
                return refuse(refusal_reason::unsupported_operand);
            }
            const value_id address = LUCENT_TRY(address_of(source));
            return memory_location{.address = address, .size = size.value_or(width::qword)};
        }
        // Zydis gives a signed immediate already sign-extended to 64 bits; the instruction's
        // operand width is what it extends to.
        if (source.type == ZYDIS_OPERAND_TYPE_IMMEDIATE) {
            return immediate_location{.value = immediate_of(source) & mask_of(operand_width())};
        }
        return refuse(refusal_reason::unsupported_operand);
    }

    auto read(const location& from) -> value_id {
        return match(
            from,
            [&](const register_location& place) {
                return emit(read_register{.source = place.reg, .size = place.size});
            },
            [&](const memory_location& place) {
                return emit(load{.address = place.address, .size = place.size});
            },
            [&](const immediate_location& place) { return number(place.value); }
        );
    }

    auto write(const location& destination, value_id value) -> void {
        match(
            destination,
            [&](const register_location& place) {
                append(write_register{.target = place.reg, .size = place.size, .value = value});
            },
            [&](const memory_location& place) {
                append(store{.address = place.address, .value = value, .size = place.size});
            },
            [](const immediate_location&) { LUCENT_UNREACHABLE(); }
        );
    }

    static auto size_of(const location& place) -> width {
        return match(
            place,
            [](const register_location& held) { return held.size; },
            [](const memory_location& held) { return held.size; },
            [](const immediate_location&) { return width::qword; }
        );
    }

    // Jcc, SETcc and CMOVcc carry the condition in their opcode's low four bits (Intel SDM vol. 2,
    // B.1.4.7), in condition's order.
    auto condition_value() -> value_id {
        const condition code{narrow<u8>(m_source.instruction.opcode & 0x0fU)};
        return emit(test_condition{.code = code});
    }

    auto branch_target() const -> std::expected<u64, refusal> {
        const ZydisDecodedOperand& target = operand(0);
        if (!is_relative(target)) {
            return refuse(refusal_reason::indirect_branch);
        }
        u64 absolute = 0;
        const ZyanStatus status =
            ZydisCalcAbsoluteAddress(&m_source.instruction, &target, m_address, &absolute);
        LUCENT_INVARIANT(ZYAN_SUCCESS(status));
        return absolute;
    }

    auto lift_mnemonic() -> std::expected<flow, refusal> {
        const std::optional<mnemonic_rule> rule = rule_of(m_source.instruction.mnemonic);
        if (!rule) {
            return refuse(refusal_reason::unsupported_instruction);
        }
        switch (rule->kind) {
        case family::move:
            return lift_move();
        case family::zero_extend:
            return lift_extend(extension::zero);
        case family::sign_extend:
            return lift_extend(extension::sign);
        case family::load_address:
            return lift_address();
        case family::push:
            return lift_push();
        case family::pop:
            return lift_pop();
        case family::arithmetic:
            return lift_arithmetic(*rule);
        case family::compare:
            return lift_compare(*rule);
        case family::step:
            return lift_step(*rule);
        case family::negate:
            return lift_negate();
        case family::invert:
            return lift_invert();
        case family::multiply:
            return lift_multiply();
        case family::shift:
            return lift_shift(*rule);
        case family::conditional_move:
            return lift_conditional_move();
        case family::set:
            return lift_set();
        case family::branch:
            return lift_branch();
        case family::jump:
            return lift_jump();
        case family::ret:
            return lift_return();
        case family::call:
            return refuse(refusal_reason::call);
        case family::nop:
            return fall_through{};
        case family::widen_accumulator:
            return lift_widen_accumulator();
        case family::sign_into_data:
            return lift_sign_into_data();
        }
        LUCENT_UNREACHABLE();
    }

    auto lift_move() -> std::expected<flow, refusal> {
        const location target = LUCENT_TRY(locate(0));
        const location source = LUCENT_TRY(locate(1));
        write(target, read(source));
        return fall_through{};
    }

    auto lift_extend(extension kind) -> std::expected<flow, refusal> {
        const location target = LUCENT_TRY(locate(0));
        const location source = LUCENT_TRY(locate(1));
        const value_id value = read(source);
        write(target, emit(extend{.source = value, .from = size_of(source), .kind = kind}));
        return fall_through{};
    }

    auto lift_address() -> std::expected<flow, refusal> {
        const location target = LUCENT_TRY(locate(0));
        const value_id address = LUCENT_TRY(address_of(operand(1)));
        write(target, address);
        return fall_through{};
    }

    auto stack_pointer() -> value_id {
        return emit(read_register{.source = gpr::rsp, .size = width::qword});
    }

    auto lift_push() -> std::expected<flow, refusal> {
        if (operand_width() != width::qword) {
            return refuse(refusal_reason::unsupported_operand);
        }
        const location source = LUCENT_TRY(locate(0));
        const value_id value = read(source);
        const value_id top = emit(
            compute{
                .kind = operator_kind::subtract,
                .size = width::qword,
                .lhs = stack_pointer(),
                .rhs = number(8),
            }
        );
        append(store{.address = top, .value = value, .size = width::qword});
        append(write_register{.target = gpr::rsp, .size = width::qword, .value = top});
        return fall_through{};
    }

    // rsp moves before the destination is written, so `pop rsp` leaves the popped value.
    auto lift_pop() -> std::expected<flow, refusal> {
        if (operand_width() != width::qword || operand(0).type != ZYDIS_OPERAND_TYPE_REGISTER) {
            return refuse(refusal_reason::unsupported_operand);
        }
        const location target = LUCENT_TRY(locate(0));
        const value_id top = stack_pointer();
        const value_id value = emit(load{.address = top, .size = width::qword});
        append(
            write_register{.target = gpr::rsp, .size = width::qword, .value = add(top, number(8))}
        );
        write(target, value);
        return fall_through{};
    }

    struct binary_outcome {
        location target;
        value_id result{};
    };

    // The operation and its flags over the two operands. adc and sbb take the carry flag as a third
    // input.
    auto compute_with_flags(const mnemonic_rule& rule) -> std::expected<binary_outcome, refusal> {
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const location source = LUCENT_TRY(locate(1));
        const value_id lhs = read(target);
        const value_id rhs = read(source);
        value_id result = emit(compute{.kind = rule.op, .size = size, .lhs = lhs, .rhs = rhs});
        if (rule.flags == flag_rule::add_with_carry
            || rule.flags == flag_rule::subtract_with_borrow) {
            const value_id carry = emit(read_flag{.bit = flag::carry});
            result = emit(compute{.kind = rule.op, .size = size, .lhs = result, .rhs = carry});
        }
        append(
            update_flags{.rule = rule.flags, .size = size, .lhs = lhs, .rhs = rhs, .result = result}
        );
        return binary_outcome{.target = target, .result = result};
    }

    auto lift_arithmetic(const mnemonic_rule& rule) -> std::expected<flow, refusal> {
        const binary_outcome outcome = LUCENT_TRY(compute_with_flags(rule));
        write(outcome.target, outcome.result);
        return fall_through{};
    }

    auto lift_compare(const mnemonic_rule& rule) -> std::expected<flow, refusal> {
        LUCENT_TRY(compute_with_flags(rule));
        return fall_through{};
    }

    // inc and dec leave the carry flag; their flag rules say so.
    auto lift_step(const mnemonic_rule& rule) -> std::expected<flow, refusal> {
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const value_id value = read(target);
        const value_id one = number(1);
        const value_id result =
            emit(compute{.kind = rule.op, .size = size, .lhs = value, .rhs = one});
        append(
            update_flags{
                .rule = rule.flags,
                .size = size,
                .lhs = value,
                .rhs = one,
                .result = result,
            }
        );
        write(target, result);
        return fall_through{};
    }

    // neg sets the flags of 0 - value (Intel SDM vol. 2, NEG: "CF set to 0 if the source operand
    // is 0").
    auto lift_negate() -> std::expected<flow, refusal> {
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const value_id value = read(target);
        const value_id zero = number(0);
        const value_id result =
            emit(compute{.kind = operator_kind::subtract, .size = size, .lhs = zero, .rhs = value});
        append(
            update_flags{
                .rule = flag_rule::subtract,
                .size = size,
                .lhs = zero,
                .rhs = value,
                .result = result,
            }
        );
        write(target, result);
        return fall_through{};
    }

    auto lift_invert() -> std::expected<flow, refusal> {
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const value_id value = read(target);
        const value_id all_ones = number(mask_of(size));
        write(
            target,
            emit(
                compute{.kind = operator_kind::bit_xor, .size = size, .lhs = value, .rhs = all_ones}
            )
        );
        return fall_through{};
    }

    // The two- and three-operand forms; the one-operand form writes rdx:rax and is refused.
    auto lift_multiply() -> std::expected<flow, refusal> {
        if (visible_operands() < 2) {
            return refuse(refusal_reason::unsupported_operand);
        }
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const location first = LUCENT_TRY(locate(visible_operands() - 2));
        const location second = LUCENT_TRY(locate(visible_operands() - 1));
        const value_id lhs = read(first);
        const value_id rhs = read(second);
        const value_id result =
            emit(compute{.kind = operator_kind::multiply, .size = size, .lhs = lhs, .rhs = rhs});
        append(
            update_flags{
                .rule = flag_rule::multiply_signed,
                .size = size,
                .lhs = lhs,
                .rhs = rhs,
                .result = result,
            }
        );
        write(target, result);
        return fall_through{};
    }

    // x86 masks the count to 5 bits, 6 for a qword, before anything else (Intel SDM vol. 2,
    // SAL/SAR/SHL/SHR and RCL/RCR/ROL/ROR, "Operation").
    auto lift_shift(const mnemonic_rule& rule) -> std::expected<flow, refusal> {
        const width size = operand_width();
        const location target = LUCENT_TRY(locate(0));
        const location count_source = LUCENT_TRY(locate(1));
        const value_id value = read(target);
        const value_id count = emit(
            compute{
                .kind = operator_kind::bit_and,
                .size = width::byte,
                .lhs = read(count_source),
                .rhs = number(size == width::qword ? 0x3f : 0x1f),
            }
        );
        const value_id result =
            emit(compute{.kind = rule.op, .size = size, .lhs = value, .rhs = count});
        append(
            update_flags{
                .rule = rule.flags,
                .size = size,
                .lhs = value,
                .rhs = count,
                .result = result,
            }
        );
        write(target, result);
        return fall_through{};
    }

    // The destination is written either way: a dword cmov zeroes the upper half even when the
    // condition fails.
    auto lift_conditional_move() -> std::expected<flow, refusal> {
        const location target = LUCENT_TRY(locate(0));
        const location source = LUCENT_TRY(locate(1));
        const value_id holds = condition_value();
        const value_id moved = read(source);
        const value_id kept = read(target);
        write(target, emit(select{.condition = holds, .if_true = moved, .if_false = kept}));
        return fall_through{};
    }

    auto lift_set() -> std::expected<flow, refusal> {
        const location target = LUCENT_TRY(locate(0));
        write(target, condition_value());
        return fall_through{};
    }

    auto lift_branch() -> std::expected<flow, refusal> {
        const u64 target = LUCENT_TRY(branch_target());
        return branch{.condition = condition_value(), .target = target};
    }

    auto lift_jump() -> std::expected<flow, refusal> {
        const u64 target = LUCENT_TRY(branch_target());
        return jump{.target = target};
    }

    auto lift_return() -> std::expected<flow, refusal> {
        u64 released = 8;
        if (visible_operands() == 1) {
            released += immediate_of(operand(0));
        }
        const value_id top = stack_pointer();
        const value_id target = emit(load{.address = top, .size = width::qword});
        append(
            write_register{
                .target = gpr::rsp,
                .size = width::qword,
                .value = add(top, number(released)),
            }
        );
        return leave{.target = target};
    }

    // cbw, cwde and cdqe: the accumulator's lower half sign-extended over all of it.
    auto lift_widen_accumulator() -> std::expected<flow, refusal> {
        const width size = operand_width();
        const width half{narrow<u8>(std::to_underlying(size) / 2)};
        const value_id value = emit(read_register{.source = gpr::rax, .size = half});
        const value_id widened =
            emit(extend{.source = value, .from = half, .kind = extension::sign});
        append(write_register{.target = gpr::rax, .size = size, .value = widened});
        return fall_through{};
    }

    // cwd, cdq and cqo: the accumulator's sign copied through the data register.
    auto lift_sign_into_data() -> std::expected<flow, refusal> {
        const width size = operand_width();
        const value_id value = emit(read_register{.source = gpr::rax, .size = size});
        const value_id sign = emit(
            compute{
                .kind = operator_kind::shift_right_arithmetic,
                .size = size,
                .lhs = value,
                .rhs = number(bits_of(size) - 1),
            }
        );
        append(write_register{.target = gpr::rdx, .size = size, .value = sign});
        return fall_through{};
    }
};

}

auto lift_instruction(std::span<const std::byte> code, u64 address)
    -> std::expected<instruction, refusal> {
    const std::optional<decoded> found = decode(code);
    if (!found) {
        return std::unexpected{refusal{
            .reason = refusal_reason::undecodable,
            .address = address,
            .mnemonic = {},
        }};
    }
    lifter builder{*found, address};
    return builder.lift();
}

}
