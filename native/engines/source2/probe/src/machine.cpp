#include "machine.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <flat_map>
#include <format>
#include <iterator>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include <Zycore/Status.h>
#include <Zydis/Decoder.h>
#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::source2::detail {
namespace {

// A run's bounds. Registration code is straight-line apart from a dispatch on its phase; the
// largest class callback on 1.41.9.9 runs a few thousand instructions.
constexpr isize max_paths = 64;
constexpr isize max_steps = 400'000;
// The registrar calls the project's type-table builder, which calls helpers: three levels reach
// every type the game builds.
constexpr isize max_depth = 3;
constexpr u32 longest_instruction = 15;
constexpr u8 pointer_width = 8;
// What fills the return address a followed call pushes; nothing reads it back.
constexpr u64 return_marker = 0;

// The methods registration code calls, by their offset in the vtable.
// build: schemasystem.dll TimeDateStamp 0x6afcfdbb, SizeOfImage 0x7f000 (cs2 1.41.9.9)
// found: CSchemaSystemTypeScope's vtable (through its RTTI) in IDA: slots 5..16 each install one
// CSchemaType_* RTTI vtable (Builtin, Ptr, Atomic, Atomic_T, Atomic_CollectionOfT, Atomic_TT,
// Atomic_I, DeclaredClass, DeclaredEnum, FixedArray, a FixedArray per dimension, Bitfield) and
// format the name with "%s*", "%s< %s >", "%s< %s, %zu >", "%s< %s, %s >", "%s< %d >", "%s[%d]",
// "bitfield:%d"; builtins are named from a table ("int32", "float32", ...). client.dll's
// registration code calls exactly these offsets, and ISchemaSystem's 0x60 for the type scope.
// breaks: a slot moves: types come out wrong or unknown, which the finders' type check catches
enum class scope_method : u8 {
    builtin = 0x28,
    pointer = 0x30,
    atomic = 0x38,
    atomic_of_type = 0x40,
    collection = 0x48,
    atomic_of_two_types = 0x50,
    atomic_of_number = 0x58,
    declared_class = 0x60,
    declared_enum = 0x68,
    fixed_array = 0x70,
    multi_array = 0x78,
    bitfield = 0x80,
};
constexpr i64 find_type_scope = 0x60;

// SchemaBuiltinType_t, as CSchemaSystemTypeScope's builtin table names them.
constexpr std::array<std::string_view, 14> builtin_names{
    "Invalid",
    "void",
    "char",
    "int8",
    "uint8",
    "int16",
    "uint16",
    "int32",
    "uint32",
    "int64",
    "uint64",
    "float32",
    "float64",
    "bool",
};
// A multi-dimensional array's dimension list ends at -1.
constexpr i64 last_dimension = -1;

enum class gpr : u8 {
    rax,
    rcx,
    rdx,
    rbx,
    rsp,
    rbp,
    rsi,
    rdi,
    r8,
    r9,
    r10,
    r11,
    r12,
    r13,
    r14,
    r15,
};
constexpr usize gpr_count = 16;
constexpr std::array argument_registers{gpr::rcx, gpr::rdx, gpr::r8, gpr::r9};
constexpr std::array volatile_registers{gpr::rcx, gpr::rdx, gpr::r8, gpr::r9, gpr::r10, gpr::r11};
// The first stack argument sits past the four home slots.
constexpr i64 first_stack_argument = 0x20;

enum class operand_kind : u8 { none, gpr, other_register, memory, immediate };

struct memory_operand {
    std::optional<gpr> base;
    bool is_rip_relative = false;
    std::optional<gpr> index;
    u8 scale = 0;
    i64 displacement = 0;
    bool has_segment = false;
};

struct operand {
    operand_kind kind = operand_kind::none;
    gpr reg = gpr::rax;
    bool is_high_byte = false;
    // In bytes.
    u8 width = 0;
    memory_operand memory;
    u64 immediate = 0;
    bool is_relative = false;
    // An xmm or ymm register, by number.
    std::optional<usize> vector;
};

enum class condition : u8 {
    zero,
    not_zero,
    below,
    not_below,
    below_or_equal,
    above,
    less,
    not_less,
    less_or_equal,
    greater,
    sign,
    not_sign,
    overflow,
    not_overflow,
    unknowable,
};

struct condition_rule {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    condition tested = condition::unknowable;
};

// Every conditional jump, move and set, by the condition it tests.
constexpr std::array condition_rules{
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JZ, .tested = condition::zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVZ, .tested = condition::zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETZ, .tested = condition::zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNZ, .tested = condition::not_zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNZ, .tested = condition::not_zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNZ, .tested = condition::not_zero},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JB, .tested = condition::below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVB, .tested = condition::below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETB, .tested = condition::below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNB, .tested = condition::not_below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNB, .tested = condition::not_below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNB, .tested = condition::not_below},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JBE, .tested = condition::below_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVBE, .tested = condition::below_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETBE, .tested = condition::below_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNBE, .tested = condition::above},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNBE, .tested = condition::above},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNBE, .tested = condition::above},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JL, .tested = condition::less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVL, .tested = condition::less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETL, .tested = condition::less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNL, .tested = condition::not_less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNL, .tested = condition::not_less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNL, .tested = condition::not_less},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JLE, .tested = condition::less_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVLE, .tested = condition::less_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETLE, .tested = condition::less_or_equal},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNLE, .tested = condition::greater},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNLE, .tested = condition::greater},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNLE, .tested = condition::greater},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JS, .tested = condition::sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVS, .tested = condition::sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETS, .tested = condition::sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNS, .tested = condition::not_sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNS, .tested = condition::not_sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNS, .tested = condition::not_sign},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JO, .tested = condition::overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVO, .tested = condition::overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETO, .tested = condition::overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNO, .tested = condition::not_overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNO, .tested = condition::not_overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNO, .tested = condition::not_overflow},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JNP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_CMOVNP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_SETNP, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JCXZ, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JECXZ, .tested = condition::unknowable},
    condition_rule{.mnemonic = ZYDIS_MNEMONIC_JRCXZ, .tested = condition::unknowable},
};

auto condition_of(ZydisMnemonic mnemonic) -> std::optional<condition> {
    const auto found = std::ranges::find(condition_rules, mnemonic, &condition_rule::mnemonic);
    if (found == condition_rules.end()) {
        return std::nullopt;
    }
    return found->tested;
}

enum class operation : u8 {
    conditional,
    move,
    extend,
    load_address,
    push,
    pop,
    leave_frame,
    call,
    ret,
    jump,
    nothing,
    stop,
    add_or_subtract,
    compare,
    test,
    logic,
    step_by_one,
    negate,
    invert,
    shift_left,
    shift_right,
    multiply,
    vector_clear,
    vector_store,
    other,
};

struct operation_rule {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    operation does = operation::other;
};

// What the machine models; any other instruction computes nothing it can know.
constexpr std::array operation_rules{
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOV, .does = operation::move},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVZX, .does = operation::extend},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVSX, .does = operation::extend},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVSXD, .does = operation::extend},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_LEA, .does = operation::load_address},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_PUSH, .does = operation::push},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_POP, .does = operation::pop},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_LEAVE, .does = operation::leave_frame},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_CALL, .does = operation::call},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_RET, .does = operation::ret},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_JMP, .does = operation::jump},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_NOP, .does = operation::nothing},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_ENDBR64, .does = operation::nothing},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_PAUSE, .does = operation::nothing},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_PREFETCHT0, .does = operation::nothing},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_PREFETCHW, .does = operation::nothing},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_INT3, .does = operation::stop},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_UD2, .does = operation::stop},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_HLT, .does = operation::stop},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_INT, .does = operation::stop},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_ADD, .does = operation::add_or_subtract},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_SUB, .does = operation::add_or_subtract},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_CMP, .does = operation::compare},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_TEST, .does = operation::test},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_AND, .does = operation::logic},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_OR, .does = operation::logic},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_XOR, .does = operation::logic},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_INC, .does = operation::step_by_one},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_DEC, .does = operation::step_by_one},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_NEG, .does = operation::negate},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_NOT, .does = operation::invert},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_SHL, .does = operation::shift_left},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_SHR, .does = operation::shift_right},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_IMUL, .does = operation::multiply},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_XORPS, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_XORPD, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_PXOR, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VXORPS, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VXORPD, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VPXOR, .does = operation::vector_clear},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVUPS, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVAPS, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVUPD, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVAPD, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVDQU, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_MOVDQA, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VMOVUPS, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VMOVAPS, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VMOVDQU, .does = operation::vector_store},
    operation_rule{.mnemonic = ZYDIS_MNEMONIC_VMOVDQA, .does = operation::vector_store},
};

auto operation_of(ZydisMnemonic mnemonic) -> operation {
    const auto found = std::ranges::find(operation_rules, mnemonic, &operation_rule::mnemonic);
    return found == operation_rules.end() ? operation::other : found->does;
}

// Which conditional instruction it is, beside the condition it tests.
enum class conditional_kind : u8 { jump, move, set };

auto conditional_kind_of(ZydisMnemonic mnemonic) -> conditional_kind {
    const std::string_view name = ZydisMnemonicGetString(mnemonic);
    if (name.starts_with("cmov")) {
        return conditional_kind::move;
    }
    return name.starts_with("set") ? conditional_kind::set : conditional_kind::jump;
}

struct instruction {
    u32 next = 0;
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    operation does = operation::other;
    condition tested = condition::unknowable;
    conditional_kind conditional = conditional_kind::jump;
    std::array<operand, 4> operands{};
    u8 count = 0;
    // General registers it writes without naming them, by bit.
    u16 hidden_writes = 0;
};

struct flags {
    std::optional<bool> zero;
    std::optional<bool> sign;
    std::optional<bool> carry;
    std::optional<bool> overflow;
};

// Vector registers matter only as the zeros compilers store with them; by ZydisRegister.
constexpr usize vector_count = 32;

struct core {
    std::array<value, gpr_count> registers{};
    std::array<bool, vector_count> is_zero_vector{};
    flags status;
    std::flat_map<i64, cell> stack;
};

struct frame {
    u32 return_rva = 0;
    core before;
};

struct path {
    core state;
    u32 rip = 0;
    std::vector<frame> frames;
};

enum class outcome : u8 { proceed, finished, failed };

struct image_place {
    u64 address = 0;
};

struct stack_place {
    i64 offset = 0;
};

struct object_place {
    object_kind kind = object_kind::schema_system;
    i64 offset = 0;
};

struct vtable_place {
    object_kind kind = object_kind::schema_system;
    i64 offset = 0;
};

struct no_place {};

using place = std::variant<image_place, stack_place, object_place, vtable_place, no_place>;

auto index_of(gpr reg) -> usize {
    return std::to_underlying(reg);
}

auto mask_of(u8 width) -> u64 {
    return width >= pointer_width ? ~u64{0} : (u64{1} << (u64{width} * 8)) - 1;
}

auto top_bit_of(u8 width) -> u64 {
    return u64{1} << ((u64{width} * 8) - 1);
}

auto stack_in(const value& held) -> std::optional<i64> {
    return match(
        held,
        [](const stack_value& stack) -> std::optional<i64> { return stack.offset; },
        [](const auto&) -> std::optional<i64> { return std::nullopt; }
    );
}

// A pointer the game made: never null, and below the top of the address space.
auto is_pointer(const value& held) -> bool {
    return match(
        held,
        [](const unknown_value&) { return false; },
        [](const number_value&) { return false; },
        [](const masked_value&) { return false; },
        [](const auto&) { return true; }
    );
}

auto narrowed(const value& held, u8 width) -> value {
    if (width >= pointer_width) {
        return held;
    }
    if (const std::optional<u64> number = number_in(held)) {
        return number_value{.bits = *number & mask_of(width)};
    }
    return unknown_value{};
}

auto gpr_of(ZydisRegister reg) -> std::optional<gpr> {
    const ZydisRegister full = ZydisRegisterGetLargestEnclosing(ZYDIS_MACHINE_MODE_LONG_64, reg);
    if (full < ZYDIS_REGISTER_RAX || full > ZYDIS_REGISTER_R15) {
        return std::nullopt;
    }
    return static_cast<gpr>(full - ZYDIS_REGISTER_RAX);
}

auto vector_of(ZydisRegister reg) -> std::optional<usize> {
    if (reg >= ZYDIS_REGISTER_XMM0 && reg <= ZYDIS_REGISTER_XMM31) {
        return narrow<usize>(reg - ZYDIS_REGISTER_XMM0);
    }
    if (reg >= ZYDIS_REGISTER_YMM0 && reg <= ZYDIS_REGISTER_YMM31) {
        return narrow<usize>(reg - ZYDIS_REGISTER_YMM0);
    }
    return std::nullopt;
}

auto is_high_byte(ZydisRegister reg) -> bool {
    return reg == ZYDIS_REGISTER_AH
           || reg == ZYDIS_REGISTER_CH
           || reg == ZYDIS_REGISTER_DH
           || reg == ZYDIS_REGISTER_BH;
}

auto memory_of(const ZydisDecodedOperandMem& memory) -> memory_operand {
    return memory_operand{
        .base = gpr_of(memory.base),
        .is_rip_relative = memory.base == ZYDIS_REGISTER_RIP,
        .index = gpr_of(memory.index),
        .scale = memory.scale,
        .displacement = memory.disp.value,
        .has_segment = memory.segment == ZYDIS_REGISTER_FS || memory.segment == ZYDIS_REGISTER_GS,
    };
}

auto operand_of(const ZydisDecodedOperand& decoded) -> operand {
    operand made{};
    made.width = narrow<u8>(decoded.size / 8);
    // NOLINTBEGIN(cppcoreguidelines-pro-type-union-access): Zydis tags the union by decoded.type.
    if (decoded.type == ZYDIS_OPERAND_TYPE_REGISTER) {
        const std::optional<gpr> reg = gpr_of(decoded.reg.value);
        made.kind = reg ? operand_kind::gpr : operand_kind::other_register;
        made.reg = reg.value_or(gpr::rax);
        made.is_high_byte = is_high_byte(decoded.reg.value);
        made.vector = vector_of(decoded.reg.value);
    } else if (decoded.type == ZYDIS_OPERAND_TYPE_MEMORY) {
        made.kind = operand_kind::memory;
        made.memory = memory_of(decoded.mem);
    } else if (decoded.type == ZYDIS_OPERAND_TYPE_IMMEDIATE) {
        made.kind = operand_kind::immediate;
        made.is_relative = decoded.imm.is_relative != 0;
        made.immediate = decoded.imm.is_signed != 0 ? static_cast<u64>(decoded.imm.value.s)
                                                    : decoded.imm.value.u;
    }
    // NOLINTEND(cppcoreguidelines-pro-type-union-access)
    return made;
}

// A general register an operand writes that isn't one of the instruction's modeled outputs.
auto hidden_write_of(const ZydisDecodedOperand& decoded) -> u16 {
    const u32 writes = static_cast<u32>(ZYDIS_OPERAND_ACTION_MASK_WRITE);
    const bool is_written = (static_cast<u32>(decoded.actions) & writes) != 0;
    if (!is_written || decoded.type != ZYDIS_OPERAND_TYPE_REGISTER) {
        return 0;
    }
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-union-access): a register operand, as checked.
    const std::optional<gpr> reg = gpr_of(decoded.reg.value);
    if (!reg || *reg == gpr::rsp) {
        return 0;
    }
    return narrow<u16>(1U << index_of(*reg));
}

auto decode(const probe::module_file& module, u32 rva) -> std::optional<instruction> {
    const u32 size_of_image = module.view().size_of_image();
    if (rva >= size_of_image) {
        return std::nullopt;
    }
    const u32 size = std::min(longest_instruction, size_of_image - rva);
    const std::optional<std::span<const std::byte>> code =
        module.bytes_at({.rva = rva, .size = size});
    if (!code) {
        return std::nullopt;
    }
    ZydisDecoder decoder{};
    LUCENT_INVARIANT(
        ZYAN_SUCCESS(ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64))
    );
    ZydisDecodedInstruction decoded{};
    std::array<ZydisDecodedOperand, ZYDIS_MAX_OPERAND_COUNT> operands{};
    if (!ZYAN_SUCCESS(
            ZydisDecoderDecodeFull(&decoder, code->data(), code->size(), &decoded, operands.data())
        )) {
        return std::nullopt;
    }
    const std::optional<condition> tested = condition_of(decoded.mnemonic);
    instruction made{};
    made.next = rva + decoded.length;
    made.mnemonic = decoded.mnemonic;
    made.does = tested ? operation::conditional : operation_of(decoded.mnemonic);
    made.tested = tested.value_or(condition::unknowable);
    made.conditional = conditional_kind_of(decoded.mnemonic);
    made.count = std::min(decoded.operand_count_visible, narrow<u8>(made.operands.size()));
    for (usize slot = 0; slot < made.count; ++slot) {
        made.operands.at(slot) = operand_of(operands.at(slot));
    }
    for (usize slot = made.count; slot < decoded.operand_count; ++slot) {
        made.hidden_writes |= hidden_write_of(operands.at(slot));
    }
    return made;
}

auto negated(std::optional<bool> fact) -> std::optional<bool> {
    return fact ? std::optional{!*fact} : std::nullopt;
}

auto either(std::optional<bool> left, std::optional<bool> right) -> std::optional<bool> {
    if (left == true || right == true) {
        return true;
    }
    if (left == false && right == false) {
        return false;
    }
    return std::nullopt;
}

auto differ(std::optional<bool> left, std::optional<bool> right) -> std::optional<bool> {
    return left && right ? std::optional{*left != *right} : std::nullopt;
}

auto holds(condition tested, const flags& status) -> std::optional<bool> {
    switch (tested) {
    case condition::zero:
        return status.zero;
    case condition::not_zero:
        return negated(status.zero);
    case condition::below:
        return status.carry;
    case condition::not_below:
        return negated(status.carry);
    case condition::below_or_equal:
        return either(status.carry, status.zero);
    case condition::above:
        return negated(either(status.carry, status.zero));
    case condition::less:
        return differ(status.sign, status.overflow);
    case condition::not_less:
        return negated(differ(status.sign, status.overflow));
    case condition::less_or_equal:
        return either(status.zero, differ(status.sign, status.overflow));
    case condition::greater:
        return negated(either(status.zero, differ(status.sign, status.overflow)));
    case condition::sign:
        return status.sign;
    case condition::not_sign:
        return negated(status.sign);
    case condition::overflow:
        return status.overflow;
    case condition::not_overflow:
        return negated(status.overflow);
    case condition::unknowable:
        return std::nullopt;
    }
    LUCENT_UNREACHABLE();
}

auto flags_of_result(u64 result, u8 width) -> flags {
    const u64 masked = result & mask_of(width);
    return flags{
        .zero = masked == 0,
        .sign = (masked & top_bit_of(width)) != 0,
        .carry = false,
        .overflow = false,
    };
}

// Two numbers an instruction combines, at its operand width.
struct operand_numbers {
    u64 left = 0;
    u64 right = 0;
    u8 width = pointer_width;
};

auto flags_of_subtraction(operand_numbers numbers) -> flags {
    const u8 width = numbers.width;
    const u64 mask = mask_of(width);
    const u64 lhs = numbers.left & mask;
    const u64 rhs = numbers.right & mask;
    const u64 result = (lhs - rhs) & mask;
    flags made = flags_of_result(result, width);
    made.carry = lhs < rhs;
    made.overflow = ((lhs ^ rhs) & (lhs ^ result) & top_bit_of(width)) != 0;
    return made;
}

auto flags_of_addition(operand_numbers numbers) -> flags {
    const u8 width = numbers.width;
    const u64 mask = mask_of(width);
    const u64 lhs = numbers.left & mask;
    const u64 right = numbers.right;
    const u64 result = (lhs + (right & mask)) & mask;
    flags made = flags_of_result(result, width);
    made.carry = result < lhs;
    made.overflow = (~(lhs ^ right) & (lhs ^ result) & top_bit_of(width)) != 0;
    return made;
}

// A pointer the game made compared with zero: all a test or compare against it can say.
auto flags_of_pointer() -> flags {
    return flags{.zero = false, .sign = false, .carry = false, .overflow = false};
}

auto read_cell(const cell& found, u8 width) -> value {
    if (found.width == width) {
        return found.stored;
    }
    if (width < found.width) {
        return narrowed(found.stored, width);
    }
    return unknown_value{};
}

// Keeps a store from leaving an older, overlapping cell to be read back.
auto erase_overlaps(std::flat_map<i64, cell>& cells, i64 offset, u8 width) -> void {
    auto found = cells.lower_bound(offset - i64{pointer_width} - i64{pointer_width});
    while (found != cells.end() && found->first < offset + i64{width}) {
        const bool overlaps = found->first + i64{found->second.width} > offset;
        found = overlaps ? cells.erase(found) : std::next(found);
    }
}

auto little_endian(std::span<const std::byte> bytes) -> u64 {
    u64 number = 0;
    for (const auto [position, part] : std::views::enumerate(bytes)) {
        number |= u64{std::to_integer<u8>(part)} << (u64{narrow<u8>(position)} * 8);
    }
    return number;
}

// One run: the paths it still has to take, the calls and stores it saw, and its budget.
class executor final {
public:
    executor(const probe::module_file& module, machine& owner)
        : m_module{&module}
        , m_owner{&owner} {}

    auto run(const entry& start) -> trace {
        explore(start);
        return std::move(m_trace);
    }

    auto explore(const entry& start) -> void {
        path first{};
        first.rip = start.rva;
        first.state.registers.fill(unknown_value{});
        for (const auto [reg, passed] : std::views::zip(argument_registers, start.arguments)) {
            first.state.registers.at(index_of(reg)) = passed;
        }
        first.state.registers.at(index_of(gpr::rsp)) = stack_value{.offset = 0};
        m_pending.push_back(std::move(first));
        isize taken = 0;
        while (!m_pending.empty() && taken < max_paths && m_steps < max_steps) {
            path current = std::move(m_pending.back());
            m_pending.pop_back();
            ++taken;
            walk(current);
        }
    }

private:
    auto walk(path& current) -> void {
        while (m_steps < max_steps) {
            ++m_steps;
            const outcome next = step(current);
            if (next == outcome::finished) {
                return;
            }
            if (next == outcome::failed && !unwind(current)) {
                return;
            }
        }
    }

    // A callee that couldn't be followed returns something unknown, as an unmodeled call would.
    static auto unwind(path& current) -> bool {
        if (current.frames.empty()) {
            return false;
        }
        const frame left = std::move(current.frames.back());
        current.frames.pop_back();
        current.state = left.before;
        current.rip = left.return_rva;
        clobber(current.state);
        return true;
    }

    auto step(path& current) -> outcome {
        const std::optional<instruction> decoded = decode(*m_module, current.rip);
        if (!decoded) {
            return outcome::failed;
        }
        current.rip = decoded->next;
        return execute(current, *decoded);
    }

    auto execute(path& current, const instruction& code) -> outcome {
        clobber_hidden(current.state, code);
        forget_vector(current.state, code);
        switch (code.does) {
        case operation::conditional:
            return conditional(current, code);
        case operation::move:
            write(current, code, code.operands.at(0), read(current, code, code.operands.at(1)));
            return outcome::proceed;
        case operation::extend:
            extend(current, code);
            return outcome::proceed;
        case operation::load_address:
            write(current, code, code.operands.at(0), address_of(current, code));
            return outcome::proceed;
        case operation::push:
            push(current.state, read(current, code, code.operands.at(0)));
            return outcome::proceed;
        case operation::pop:
            write(current, code, code.operands.at(0), pop(current.state));
            return outcome::proceed;
        case operation::leave_frame:
            current.state.registers.at(index_of(gpr::rsp)) =
                current.state.registers.at(index_of(gpr::rbp));
            current.state.registers.at(index_of(gpr::rbp)) = pop(current.state);
            return outcome::proceed;
        case operation::call:
            return call(current, code);
        case operation::ret:
            return leave(current);
        case operation::jump:
            return jump(current, code);
        case operation::nothing:
            return outcome::proceed;
        case operation::stop:
            return outcome::failed;
        case operation::add_or_subtract:
        case operation::compare:
        case operation::test:
        case operation::logic:
        case operation::step_by_one:
        case operation::negate:
        case operation::invert:
        case operation::shift_left:
        case operation::shift_right:
        case operation::multiply:
        case operation::other:
            arithmetic(current, code);
            return outcome::proceed;
        case operation::vector_clear:
        case operation::vector_store:
            vector(current, code);
            return outcome::proceed;
        }
        LUCENT_UNREACHABLE();
    }

    auto arithmetic(path& current, const instruction& code) -> void {
        if (code.does == operation::add_or_subtract) {
            add_or_subtract(current, code);
        } else if (code.does == operation::compare) {
            current.state.status = compared(current, code);
        } else if (code.does == operation::test) {
            current.state.status = tested(current, code);
        } else if (code.does == operation::logic) {
            logic(current, code);
        } else if (code.does == operation::step_by_one) {
            step_by_one(current, code);
        } else {
            numeric(current, code);
        }
    }

    // Everything else computes only on numbers; anything it writes becomes unknown otherwise.
    auto numeric(path& current, const instruction& code) -> void {
        const std::optional<u64> result = computed(current, code);
        if (code.count > 0 && code.operands.at(0).kind != operand_kind::immediate) {
            const value made =
                result ? value{number_value{.bits = *result}} : value{unknown_value{}};
            write(current, code, code.operands.at(0), made);
        }
        current.state.status =
            result ? flags_of_result(*result, code.operands.at(0).width) : flags{};
    }

    auto computed(const path& current, const instruction& code) const -> std::optional<u64> {
        const std::optional<u64> first = number_at(current, code, 0);
        const std::optional<u64> second = number_at(current, code, 1);
        switch (code.does) {
        case operation::negate:
            return first ? std::optional{u64{0} - *first} : std::nullopt;
        case operation::invert:
            return first ? std::optional{~*first} : std::nullopt;
        case operation::shift_left:
            return first && second ? std::optional{*first << (*second & 63U)} : std::nullopt;
        case operation::shift_right:
            return first && second ? std::optional{*first >> (*second & 63U)} : std::nullopt;
        case operation::multiply:
            return product(current, code);
        case operation::conditional:
        case operation::move:
        case operation::extend:
        case operation::load_address:
        case operation::push:
        case operation::pop:
        case operation::leave_frame:
        case operation::call:
        case operation::ret:
        case operation::jump:
        case operation::nothing:
        case operation::stop:
        case operation::add_or_subtract:
        case operation::compare:
        case operation::test:
        case operation::logic:
        case operation::step_by_one:
        case operation::vector_clear:
        case operation::vector_store:
        case operation::other:
            return std::nullopt;
        }
        LUCENT_UNREACHABLE();
    }

    auto product(const path& current, const instruction& code) const -> std::optional<u64> {
        const std::optional<u64> first = number_at(current, code, 0);
        const std::optional<u64> second = number_at(current, code, 1);
        const std::optional<u64> third = number_at(current, code, 2);
        if (code.count == 3) {
            return second && third ? std::optional{*second * *third} : std::nullopt;
        }
        return first && second && code.count == 2 ? std::optional{*first * *second} : std::nullopt;
    }

    auto number_at(const path& current, const instruction& code, usize slot) const
        -> std::optional<u64> {
        if (slot >= code.count) {
            return std::nullopt;
        }
        return number_in(read(current, code, code.operands.at(slot)));
    }

    // Any write to a vector register but a clear leaves it unknown.
    static auto forget_vector(core& state, const instruction& code) -> void {
        const bool is_clear = code.does == operation::vector_clear;
        const std::optional<usize> written =
            code.count > 0 ? code.operands.at(0).vector : std::nullopt;
        if (written && !is_clear) {
            state.is_zero_vector.at(*written) = false;
        }
    }

    // `xorps xmm0, xmm0; movups [rsp+0x30], xmm0`: zeroed arguments and locals.
    auto vector(path& current, const instruction& code) -> void {
        const operand& target = code.operands.at(0);
        const operand& source = code.operands.at(1);
        if (code.does == operation::vector_clear) {
            if (target.vector) {
                current.state.is_zero_vector.at(*target.vector) =
                    code.count >= 2 && source.vector == target.vector;
            }
            return;
        }
        if (target.kind != operand_kind::memory) {
            return;
        }
        const bool is_zero = source.vector && current.state.is_zero_vector.at(*source.vector);
        const place destination = place_of(current, code, target);
        for (const u8 half : std::views::iota(u8{0}, narrow<u8>(target.width / pointer_width))) {
            const value stored = is_zero ? value{number_value{.bits = 0}} : value{unknown_value{}};
            store(
                current.state,
                shifted(destination, i64{half} * pointer_width),
                stored,
                pointer_width
            );
        }
    }

    static auto shifted(const place& start, i64 distance) -> place {
        return match(
            start,
            [&](const image_place& image) -> place {
                return image_place{.address = image.address + std::bit_cast<u64>(distance)};
            },
            [&](const stack_place& stack) -> place {
                return stack_place{.offset = stack.offset + distance};
            },
            [](const auto&) -> place { return no_place{}; }
        );
    }

    // Registers an instruction writes without naming them (mul, div, cpuid, rep movs).
    static auto clobber_hidden(core& state, const instruction& code) -> void {
        for (const usize reg : std::views::iota(usize{0}, gpr_count)) {
            if ((code.hidden_writes & (1U << reg)) != 0) {
                state.registers.at(reg) = unknown_value{};
            }
        }
    }

    auto add_or_subtract(path& current, const instruction& code) -> void {
        const operand& target = code.operands.at(0);
        const value left = read(current, code, target);
        const value right = read(current, code, code.operands.at(1));
        const bool is_subtraction = code.mnemonic == ZYDIS_MNEMONIC_SUB;
        const std::optional<u64> lhs = number_in(left);
        const std::optional<u64> rhs = number_in(right);
        if (lhs && rhs) {
            const u64 result = is_subtraction ? *lhs - *rhs : *lhs + *rhs;
            current.state.status =
                is_subtraction
                    ? flags_of_subtraction({.left = *lhs, .right = *rhs, .width = target.width})
                    : flags_of_addition({.left = *lhs, .right = *rhs, .width = target.width});
            write(current, code, target, number_value{.bits = result});
            return;
        }
        current.state.status = flags{};
        const std::optional<i64> stack = stack_in(left);
        if (stack && rhs) {
            const auto delta = std::bit_cast<i64>(*rhs);
            write(
                current,
                code,
                target,
                stack_value{.offset = is_subtraction ? *stack - delta : *stack + delta}
            );
            return;
        }
        write(current, code, target, unknown_value{});
    }

    auto compared(const path& current, const instruction& code) const -> flags {
        const operand& left = code.operands.at(0);
        const value lhs = read(current, code, left);
        const value rhs = read(current, code, code.operands.at(1));
        const std::optional<u64> left_number = number_in(lhs);
        const std::optional<u64> right_number = number_in(rhs);
        if (left_number && right_number) {
            return flags_of_subtraction(
                {.left = *left_number, .right = *right_number, .width = left.width}
            );
        }
        if (is_pointer(lhs) && right_number == 0) {
            return flags_of_pointer();
        }
        return flags{};
    }

    auto tested(const path& current, const instruction& code) const -> flags {
        const operand& left = code.operands.at(0);
        const value lhs = read(current, code, left);
        const value rhs = read(current, code, code.operands.at(1));
        const std::optional<u64> left_number = number_in(lhs);
        const std::optional<u64> right_number = number_in(rhs);
        if (left_number && right_number) {
            return flags_of_result(*left_number & *right_number, left.width);
        }
        if (is_pointer(lhs) && lhs == rhs) {
            return flags_of_pointer();
        }
        return flags{};
    }

    auto logic(path& current, const instruction& code) -> void {
        const operand& target = code.operands.at(0);
        const operand& source = code.operands.at(1);
        const bool is_self = target.kind == operand_kind::gpr
                             && source.kind == operand_kind::gpr
                             && target.reg == source.reg;
        if (code.mnemonic == ZYDIS_MNEMONIC_XOR && is_self) {
            write(current, code, target, number_value{.bits = 0});
            current.state.status = flags_of_result(0, target.width);
            return;
        }
        const value left = read(current, code, target);
        const std::optional<u64> lhs = number_in(left);
        const std::optional<u64> rhs = number_in(read(current, code, source));
        if (lhs && rhs) {
            const u64 result = combined(code.mnemonic, *lhs, *rhs);
            write(current, code, target, number_value{.bits = result});
            current.state.status = flags_of_result(result, target.width);
            return;
        }
        current.state.status = flags{};
        if (code.mnemonic == ZYDIS_MNEMONIC_XOR) {
            write(current, code, target, masked(left, stack_in(read(current, code, source))));
            return;
        }
        write(current, code, target, aligned(left, code.mnemonic, rhs));
    }

    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters): and, or and xor are symmetric.
    static auto combined(ZydisMnemonic mnemonic, u64 left, u64 right) -> u64 {
        if (mnemonic == ZYDIS_MNEMONIC_AND) {
            return left & right;
        }
        return mnemonic == ZYDIS_MNEMONIC_OR ? left | right : left ^ right;
    }

    // /GS: the cookie xored with rsp, and back.
    static auto masked(const value& left, std::optional<i64> stack) -> value {
        if (!stack) {
            return unknown_value{};
        }
        if (const std::optional<u64> number = number_in(left)) {
            return masked_value{.bits = *number, .offset = *stack};
        }
        return match(
            left,
            [&](const masked_value& cookie) -> value {
                if (cookie.offset != *stack) {
                    return unknown_value{};
                }
                return number_value{.bits = cookie.bits};
            },
            [](const auto&) -> value { return unknown_value{}; }
        );
    }

    // `and rsp, -16`: rsp is 8 past a 16-byte boundary at entry, so the aligned offset is known.
    static auto aligned(const value& left, ZydisMnemonic mnemonic, std::optional<u64> mask)
        -> value {
        const std::optional<i64> stack = stack_in(left);
        if (!stack || !mask || mnemonic != ZYDIS_MNEMONIC_AND) {
            return unknown_value{};
        }
        const auto alignment = std::bit_cast<i64>(*mask);
        if (alignment < -16) {
            return unknown_value{};
        }
        const u64 aligned_top = std::bit_cast<u64>(*stack + 8) & std::bit_cast<u64>(alignment);
        return stack_value{.offset = std::bit_cast<i64>(aligned_top) - 8};
    }

    auto step_by_one(path& current, const instruction& code) -> void {
        const operand& target = code.operands.at(0);
        const std::optional<u64> number = number_in(read(current, code, target));
        const std::optional<bool> carry = current.state.status.carry;
        if (!number) {
            current.state.status = flags{.zero = {}, .sign = {}, .carry = carry, .overflow = {}};
            write(current, code, target, unknown_value{});
            return;
        }
        const bool is_increment = code.mnemonic == ZYDIS_MNEMONIC_INC;
        current.state.status =
            is_increment
                ? flags_of_addition({.left = *number, .right = 1, .width = target.width})
                : flags_of_subtraction({.left = *number, .right = 1, .width = target.width});
        current.state.status.carry = carry;
        write(
            current, code, target, number_value{.bits = is_increment ? *number + 1 : *number - 1}
        );
    }

    auto extend(path& current, const instruction& code) -> void {
        const operand& source = code.operands.at(1);
        const std::optional<u64> number = number_in(read(current, code, source));
        if (!number) {
            write(current, code, code.operands.at(0), unknown_value{});
            return;
        }
        u64 extended = *number & mask_of(source.width);
        const bool is_signed = code.mnemonic != ZYDIS_MNEMONIC_MOVZX;
        if (is_signed && (extended & top_bit_of(source.width)) != 0) {
            extended |= ~mask_of(source.width);
        }
        write(current, code, code.operands.at(0), number_value{.bits = extended});
    }

    auto conditional(path& current, const instruction& code) -> outcome {
        const std::optional<bool> is_met = holds(code.tested, current.state.status);
        const operand& target = code.operands.at(0);
        switch (code.conditional) {
        case conditional_kind::jump:
            return branch(current, code, is_met);
        case conditional_kind::move:
            write(current, code, target, moved_if(current, code, is_met));
            return outcome::proceed;
        case conditional_kind::set:
            write(
                current,
                code,
                target,
                is_met ? value{number_value{.bits = *is_met ? 1U : 0U}} : value{unknown_value{}}
            );
            return outcome::proceed;
        }
        LUCENT_UNREACHABLE();
    }

    auto moved_if(const path& current, const instruction& code, std::optional<bool> is_met) const
        -> value {
        if (!is_met) {
            return unknown_value{};
        }
        return read(current, code, code.operands.at(*is_met ? 1 : 0));
    }

    auto branch(path& current, const instruction& code, std::optional<bool> is_taken) -> outcome {
        const std::optional<u32> target = target_rva(current, code);
        if (!target) {
            return outcome::failed;
        }
        if (is_taken) {
            current.rip = *is_taken ? *target : code.next;
            return outcome::proceed;
        }
        if (!current.frames.empty()) {
            return outcome::failed;
        }
        if (narrow<isize>(m_pending.size()) < max_paths) {
            path taken = current;
            taken.rip = *target;
            m_pending.push_back(std::move(taken));
        }
        return outcome::proceed;
    }

    // Where a branch, call or jump goes, as an RVA in code; absent when it leaves the image's code
    // or can't be known.
    auto target_rva(const path& current, const instruction& code) const -> std::optional<u32> {
        const std::optional<u64> address = number_in(target_of(current, code));
        const std::optional<u32> rva = address ? m_module->rva_of(*address) : std::nullopt;
        if (!rva || !m_module->is_code(*rva)) {
            return std::nullopt;
        }
        return *rva;
    }

    auto target_of(const path& current, const instruction& code) const -> value {
        const operand& target = code.operands.at(0);
        if (target.kind == operand_kind::immediate && target.is_relative) {
            return number_value{.bits = image_address(code.next) + target.immediate};
        }
        return read(current, code, target);
    }

    auto jump(path& current, const instruction& code) -> outcome {
        if (const std::optional<u32> target = target_rva(current, code)) {
            current.rip = *target;
            return outcome::proceed;
        }
        // A tail call out of what can be followed: it returns from here with something unknown.
        clobber(current.state);
        return leave(current);
    }

    static auto leave(path& current) -> outcome {
        if (current.frames.empty()) {
            return outcome::finished;
        }
        const frame left = std::move(current.frames.back());
        current.frames.pop_back();
        current.state.registers.at(index_of(gpr::rsp)) =
            left.before.registers.at(index_of(gpr::rsp));
        current.rip = left.return_rva;
        return outcome::proceed;
    }

    auto call(path& current, const instruction& code) -> outcome {
        const value target = target_of(current, code);
        const call_event seen = event_of(current.state, target);
        m_trace.calls.push_back(seen);
        if (const std::optional<method_value> method = method_in(target)) {
            model(current, seen, *method);
            return outcome::proceed;
        }
        const std::optional<u32> callee = target_rva(current, code);
        if (!callee || narrow<isize>(current.frames.size()) >= max_depth) {
            clobber(current.state);
            return outcome::proceed;
        }
        current.frames.push_back(frame{.return_rva = code.next, .before = current.state});
        push(current.state, number_value{.bits = return_marker});
        current.rip = *callee;
        return outcome::proceed;
    }

    static auto method_in(const value& held) -> std::optional<method_value> {
        return match(
            held,
            [](const method_value& method) -> std::optional<method_value> { return method; },
            [](const auto&) -> std::optional<method_value> { return std::nullopt; }
        );
    }

    static auto event_of(const core& state, const value& target) -> call_event {
        call_event seen{};
        seen.target = target;
        for (const auto [reg, passed] : std::views::zip(argument_registers, seen.arguments)) {
            passed = state.registers.at(index_of(reg));
        }
        const std::optional<i64> top = stack_in(state.registers.at(index_of(gpr::rsp)));
        for (const auto [position, passed] : std::views::enumerate(seen.stack_arguments)) {
            passed = top ? stack_argument(state, *top + first_stack_argument + (position * 8))
                         : value{unknown_value{}};
        }
        return seen;
    }

    auto model(path& current, const call_event& seen, method_value method) -> void {
        const value out = seen.arguments.at(1);
        if (method.kind == object_kind::schema_system && method.offset == find_type_scope) {
            clobber(current.state);
            current.state.registers.at(index_of(gpr::rax)) =
                object_value{.kind = object_kind::type_scope};
            return;
        }
        if (method.kind != object_kind::type_scope || !is_constructor(method.offset)) {
            clobber(current.state);
            return;
        }
        const std::optional<std::string> name = constructed(seen, method.offset);
        clobber(current.state);
        const value made = name ? value{m_owner->intern(*name)} : value{unknown_value{}};
        store(current.state, place_of_value(out), made, pointer_width);
        current.state.registers.at(index_of(gpr::rax)) = out;
    }

    static auto is_constructor(i64 offset) -> bool {
        return offset >= i64{std::to_underlying(scope_method::builtin)}
               && offset <= i64{std::to_underlying(scope_method::bitfield)}
               && offset % pointer_width == 0;
    }

    // The type's name as the type scope formats it.
    auto constructed(const call_event& seen, i64 offset) const -> std::optional<std::string> {
        const value& third = seen.arguments.at(2);
        const value& fourth = seen.arguments.at(3);
        switch (static_cast<scope_method>(offset)) {
        case scope_method::builtin:
            return builtin_named(third);
        case scope_method::pointer:
            return joined("{}*", type_named(third));
        case scope_method::atomic:
        case scope_method::declared_class:
        case scope_method::declared_enum:
            return text_at(third);
        case scope_method::atomic_of_type:
            return joined("{}< {} >", text_at(third), type_named(seen.stack_arguments.at(1)));
        case scope_method::collection:
            return collection_named(seen);
        case scope_method::atomic_of_two_types:
            return joined(
                "{}< {}, {} >",
                text_at(third),
                type_named(seen.stack_arguments.at(1)),
                type_named(seen.stack_arguments.at(2))
            );
        case scope_method::atomic_of_number:
            return joined("{}< {} >", text_at(third), signed_in(seen.stack_arguments.at(1)));
        case scope_method::fixed_array:
            return joined("{}[{}]", type_named(third), signed_in(fourth));
        case scope_method::multi_array:
            return multi_array_named(seen);
        case scope_method::bitfield:
            return joined("bitfield:{}", signed_in(third));
        }
        return std::nullopt;
    }

    static auto joined(std::string_view format, const std::optional<std::string>& part)
        -> std::optional<std::string> {
        if (!part) {
            return std::nullopt;
        }
        return std::vformat(format, std::make_format_args(*part));
    }

    static auto joined(
        std::string_view format,
        const std::optional<std::string>& first,
        const std::optional<std::string>& second
    ) -> std::optional<std::string> {
        if (!first || !second) {
            return std::nullopt;
        }
        return std::vformat(format, std::make_format_args(*first, *second));
    }

    static auto joined(
        std::string_view format,
        const std::optional<std::string>& first,
        const std::optional<std::string>& second,
        const std::optional<std::string>& third
    ) -> std::optional<std::string> {
        if (!first || !second || !third) {
            return std::nullopt;
        }
        return std::vformat(format, std::make_format_args(*first, *second, *third));
    }

    static auto builtin_named(const value& kind) -> std::optional<std::string> {
        const std::optional<u64> number = number_in(narrowed(kind, 4));
        if (!number || *number >= builtin_names.size()) {
            return std::nullopt;
        }
        return std::string{builtin_names.at(*number)};
    }

    static auto signed_in(const value& held) -> std::optional<std::string> {
        const std::optional<u64> number = number_in(narrowed(held, 4));
        if (!number) {
            return std::nullopt;
        }
        return std::to_string(static_cast<i32>(static_cast<u32>(*number)));
    }

    auto collection_named(const call_event& seen) const -> std::optional<std::string> {
        const std::optional<std::string> name = text_at(seen.arguments.at(2));
        const std::optional<std::string> element = type_named(seen.stack_arguments.at(2));
        const std::optional<u64> fixed = number_in(seen.stack_arguments.at(3));
        if (!fixed) {
            return std::nullopt;
        }
        if (*fixed == 0) {
            return joined("{}< {} >", name, element);
        }
        return joined("{}< {}, {} >", name, element, std::to_string(*fixed));
    }

    // SchemaSystem wraps the element in the last dimension first, then each one before it.
    auto multi_array_named(const call_event& seen) const -> std::optional<std::string> {
        const std::optional<std::string> element = type_named(seen.arguments.at(2));
        if (!element) {
            return std::nullopt;
        }
        std::vector<std::string> dimensions;
        for (const value& passed : std::span{seen.stack_arguments}.subspan(1)) {
            const std::optional<u64> number = number_in(narrowed(passed, 4));
            if (!number) {
                return std::nullopt;
            }
            if (static_cast<i32>(static_cast<u32>(*number)) == last_dimension) {
                break;
            }
            dimensions.push_back(std::to_string(static_cast<i32>(static_cast<u32>(*number))));
        }
        if (dimensions.empty()) {
            return std::nullopt;
        }
        std::string name = *element;
        for (const std::string& dimension : dimensions | std::views::reverse) {
            name = std::format("{}[{}]", name, dimension);
        }
        return name;
    }

    auto type_named(const value& held) const -> std::optional<std::string> {
        return match(
            held,
            [this](const type_value& made) -> std::optional<std::string> {
                return std::string{m_owner->type_name(made.index)};
            },
            [](const auto&) -> std::optional<std::string> { return std::nullopt; }
        );
    }

    auto text_at(const value& held) const -> std::optional<std::string> {
        const std::optional<u64> address = number_in(held);
        const std::optional<u32> rva = address ? m_module->rva_of(*address) : std::nullopt;
        if (!rva) {
            return std::nullopt;
        }
        result<std::string> text = m_module->view().string_at(*rva);
        if (!text || text->empty()) {
            return std::nullopt;
        }
        return std::move(*text);
    }

    // What an unmodeled call leaves: volatile registers and flags unknown, and whatever it was
    // handed a stack address for possibly written.
    static auto clobber(core& state) -> void {
        for (const gpr reg : argument_registers) {
            if (const std::optional<i64> stack = stack_in(state.registers.at(index_of(reg)))) {
                erase_overlaps(state.stack, *stack, pointer_width);
            }
        }
        for (const gpr reg : volatile_registers) {
            state.registers.at(index_of(reg)) = unknown_value{};
        }
        state.registers.at(index_of(gpr::rax)) = unknown_value{};
        state.status = flags{};
    }

    auto image_address(u32 rva) const -> u64 {
        return m_module->view().image_base() + rva;
    }

    auto place_of(const path& current, const instruction& code, const operand& memory) const
        -> place {
        const memory_operand& parts = memory.memory;
        if (parts.has_segment) {
            return no_place{};
        }
        value base = number_value{.bits = 0};
        if (parts.is_rip_relative) {
            base = number_value{.bits = image_address(code.next)};
        } else if (parts.base) {
            base = current.state.registers.at(index_of(*parts.base));
        }
        u64 index = 0;
        if (parts.index) {
            const std::optional<u64> number =
                number_in(current.state.registers.at(index_of(*parts.index)));
            if (!number) {
                return no_place{};
            }
            index = *number * parts.scale;
        }
        const u64 offset = index + std::bit_cast<u64>(parts.displacement);
        const bool is_indexed = parts.index.has_value();
        return match(
            base,
            [&](const number_value& number) -> place {
                return image_place{.address = number.bits + offset};
            },
            [&](const stack_value& stack) -> place {
                return stack_place{.offset = stack.offset + std::bit_cast<i64>(offset)};
            },
            [&](const object_value& object) -> place {
                return is_indexed
                           ? place{no_place{}}
                           : place{object_place{.kind = object.kind, .offset = parts.displacement}};
            },
            [&](const vtable_value& table) -> place {
                return is_indexed
                           ? place{no_place{}}
                           : place{vtable_place{.kind = table.kind, .offset = parts.displacement}};
            },
            [](const auto&) -> place { return no_place{}; }
        );
    }

    static auto place_of_value(const value& address) -> place {
        return match(
            address,
            [](const number_value& number) -> place { return image_place{.address = number.bits}; },
            [](const stack_value& stack) -> place { return stack_place{.offset = stack.offset}; },
            [](const auto&) -> place { return no_place{}; }
        );
    }

    auto address_of(const path& current, const instruction& code) const -> value {
        return match(
            place_of(current, code, code.operands.at(1)),
            [](const image_place& image) -> value { return number_value{.bits = image.address}; },
            [](const stack_place& stack) -> value { return stack_value{.offset = stack.offset}; },
            [](const auto&) -> value { return unknown_value{}; }
        );
    }

    auto read(const path& current, const instruction& code, const operand& source) const -> value {
        switch (source.kind) {
        case operand_kind::gpr:
            if (source.is_high_byte) {
                return unknown_value{};
            }
            return narrowed(current.state.registers.at(index_of(source.reg)), source.width);
        case operand_kind::immediate:
            return number_value{.bits = source.immediate & mask_of(source.width)};
        case operand_kind::memory:
            return load(current.state, place_of(current, code, source), source.width);
        case operand_kind::none:
        case operand_kind::other_register:
            return unknown_value{};
        }
        LUCENT_UNREACHABLE();
    }

    auto write(path& current, const instruction& code, const operand& target, const value& written)
        -> void {
        switch (target.kind) {
        case operand_kind::gpr:
            set_register(current.state, target, written);
            return;
        case operand_kind::memory:
            store(current.state, place_of(current, code, target), written, target.width);
            return;
        case operand_kind::none:
        case operand_kind::other_register:
        case operand_kind::immediate:
            return;
        }
        LUCENT_UNREACHABLE();
    }

    static auto set_register(core& state, const operand& target, const value& written) -> void {
        value& held = state.registers.at(index_of(target.reg));
        if (target.width >= pointer_width) {
            held = written;
            return;
        }
        if (target.width == 4) {
            held = narrowed(written, 4);
            return;
        }
        const std::optional<u64> old = number_in(held);
        const std::optional<u64> part = number_in(written);
        if (!old || !part || target.is_high_byte) {
            held = unknown_value{};
            return;
        }
        const u64 mask = mask_of(target.width);
        held = number_value{.bits = (*old & ~mask) | (*part & mask)};
    }

    auto load(const core& state, const place& from, u8 width) const -> value {
        return match(
            from,
            [&](const image_place& image) -> value {
                return m_owner->load(*m_module, image.address, width);
            },
            [&](const stack_place& stack) -> value {
                return load_stack(state, stack.offset, width);
            },
            [&](const object_place& object) -> value {
                if (object.offset != 0 || width != pointer_width) {
                    return unknown_value{};
                }
                return vtable_value{.kind = object.kind};
            },
            [&](const vtable_place& table) -> value {
                if (width != pointer_width) {
                    return unknown_value{};
                }
                return method_value{.kind = table.kind, .offset = table.offset};
            },
            [](const no_place&) -> value { return unknown_value{}; }
        );
    }

    // A stack argument as the caller stored it: narrower arguments only ever fill their low bytes.
    static auto stack_argument(const core& state, i64 offset) -> value {
        const auto found = state.stack.find(offset);
        if (found == state.stack.end()) {
            return unknown_value{};
        }
        return found->second.stored;
    }

    // NOLINTNEXTLINE(bugprone-easily-swappable-parameters): an offset and a width, named at the call.
    static auto load_stack(const core& state, i64 offset, u8 width) -> value {
        const auto found = state.stack.find(offset);
        if (found == state.stack.end()) {
            return unknown_value{};
        }
        return read_cell(found->second, width);
    }

    auto store(core& state, const place& destination, const value& stored, u8 width) -> void {
        match(
            destination,
            [&](const image_place& image) {
                m_owner->write(image.address, stored, width);
                m_trace.stores.push_back(store_event{.address = image.address, .stored = stored});
            },
            [&](const stack_place& stack) {
                erase_overlaps(state.stack, stack.offset, width);
                state.stack.insert_or_assign(stack.offset, cell{.stored = stored, .width = width});
            },
            [](const auto&) {}
        );
    }

    static auto push(core& state, const value& pushed) -> void {
        value& top = state.registers.at(index_of(gpr::rsp));
        const std::optional<i64> stack = stack_in(top);
        if (!stack) {
            return;
        }
        top = stack_value{.offset = *stack - pointer_width};
        erase_overlaps(state.stack, *stack - pointer_width, pointer_width);
        state.stack.insert_or_assign(
            *stack - pointer_width, cell{.stored = pushed, .width = pointer_width}
        );
    }

    static auto pop(core& state) -> value {
        value& top = state.registers.at(index_of(gpr::rsp));
        const std::optional<i64> stack = stack_in(top);
        if (!stack) {
            return unknown_value{};
        }
        top = stack_value{.offset = *stack + pointer_width};
        return load_stack(state, *stack, pointer_width);
    }

    const probe::module_file* m_module = nullptr;
    machine* m_owner = nullptr;
    trace m_trace;
    std::vector<path> m_pending;
    isize m_steps = 0;
};

}

auto number_in(const value& held) -> std::optional<u64> {
    return match(
        held,
        [](const number_value& number) -> std::optional<u64> { return number.bits; },
        [](const auto&) -> std::optional<u64> { return std::nullopt; }
    );
}

machine::machine(const probe::module_file& module)
    : m_image_base{module.view().image_base()} {}

auto machine::run(const probe::module_file& module, const entry& start) -> trace {
    LUCENT_INVARIANT(module.view().image_base() == m_image_base);
    executor running{module, *this};
    return running.run(start);
}

auto machine::settle(const probe::module_file& module, const entry& start) -> void {
    LUCENT_INVARIANT(module.view().image_base() == m_image_base);
    executor running{module, *this};
    running.explore(start);
}

auto machine::write(u64 address, value stored, u8 width) -> void {
    m_memory.insert_or_assign(address, cell{.stored = stored, .width = width});
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters): an address and a width, named at the call.
auto machine::load(const probe::module_file& module, u64 address, u8 width) const -> value {
    if (const auto found = m_memory.find(address); found != m_memory.end()) {
        return read_cell(found->second, width);
    }
    const std::optional<u32> rva = module.rva_of(address);
    const std::optional<std::span<const std::byte>> bytes =
        rva ? module.bytes_at({.rva = *rva, .size = width}) : std::nullopt;
    if (!bytes) {
        return unknown_value{};
    }
    return number_value{.bits = little_endian(*bytes)};
}

auto machine::type_name(isize index) const -> std::string_view {
    return m_type_names.at(narrow<usize>(index));
}

auto machine::intern(std::string name) -> type_value {
    const auto found = std::ranges::find(m_type_names, name);
    if (found != m_type_names.end()) {
        return type_value{.index = std::distance(m_type_names.begin(), found)};
    }
    m_type_names.push_back(std::move(name));
    return type_value{.index = narrow<isize>(m_type_names.size()) - 1};
}

}
