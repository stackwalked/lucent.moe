#include <lucent/probe/instruction_pattern.hpp>

#include <algorithm>
#include <array>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

#include "decoder.hpp"

// build: Zydis 4.1 (vcpkg baseline 8f0be20f); the operand's union member is chosen by its type,
// and mnemonic and register names are ZydisMnemonicGetString's and ZydisRegisterGetString's.
// found: Zydis DecoderTypes.h (ZydisDecodedOperand), Mnemonic.h, Register.h
// breaks: patterns stop matching or a name stops resolving; the probe pattern tests fail
namespace lucent::probe {
namespace {

struct operand_view {
    ZydisOperandType type = ZYDIS_OPERAND_TYPE_UNUSED;
    ZydisRegister reg = ZYDIS_REGISTER_NONE;
    ZydisRegister base = ZYDIS_REGISTER_NONE;
    ZydisRegister index = ZYDIS_REGISTER_NONE;
    u8 scale = 0;
    bool is_relative = false;
    u16 width = 0;
    i64 displacement = 0;
    u64 immediate = 0;
};

struct instruction_view {
    u32 rva = 0;
    u32 next = 0;
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    u8 operand_count = 0;
    std::array<operand_view, detail::step_pattern::max_operands> operands{};
};

// The registers a step's text names, looked up once per search.
struct operand_names {
    ZydisRegister reg = ZYDIS_REGISTER_NONE;
    ZydisRegister base = ZYDIS_REGISTER_NONE;
    ZydisRegister index = ZYDIS_REGISTER_NONE;
};

struct step_names {
    ZydisMnemonic mnemonic = ZYDIS_MNEMONIC_INVALID;
    std::array<operand_names, detail::step_pattern::max_operands> operands{};
};

struct resolved {
    std::vector<detail::step_pattern> steps;
    std::vector<step_names> names;
    u32 size_of_image = 0;
};

struct bindings {
    std::array<ZydisRegister, instruction_pattern::max_names> registers{};
    std::array<u64, instruction_pattern::max_names> captures{};
};

auto is_named(const char* stored, std::string_view name) -> bool {
    return stored != nullptr && std::string_view{stored} == name;
}

auto mnemonic_named(std::string_view name) -> ZydisMnemonic {
    for (i32 value = 0; value <= ZYDIS_MNEMONIC_MAX_VALUE; ++value) {
        const auto mnemonic = static_cast<ZydisMnemonic>(value);
        if (is_named(ZydisMnemonicGetString(mnemonic), name)) {
            return mnemonic;
        }
    }
    LUCENT_INVARIANT(false);
    return ZYDIS_MNEMONIC_INVALID;
}

auto register_named(std::string_view name) -> ZydisRegister {
    for (i32 value = 1; value <= ZYDIS_REGISTER_MAX_VALUE; ++value) {
        const auto reg = static_cast<ZydisRegister>(value);
        if (is_named(ZydisRegisterGetString(reg), name)) {
            return reg;
        }
    }
    LUCENT_INVARIANT(false);
    return ZYDIS_REGISTER_NONE;
}

auto names_of(const detail::step_pattern& step) -> step_names {
    step_names named{};
    if (!step.is_gap && !step.is_any_mnemonic) {
        named.mnemonic = mnemonic_named(step.mnemonic.view());
    }
    for (usize at = 0; at < step.operand_count; ++at) {
        const detail::operand_pattern& operand = step.operands.at(at);
        operand_names& registers = named.operands.at(at);
        if (operand.rule == detail::operand_rule::exact_register) {
            registers.reg = register_named(operand.register_name.view());
        }
        if (operand.rule == detail::operand_rule::memory) {
            if (operand.memory.base == detail::base_rule::exact_register) {
                registers.base = register_named(operand.memory.base_name.view());
            }
            if (operand.memory.index == detail::index_rule::exact_register) {
                registers.index = register_named(operand.memory.index_name.view());
            }
        }
    }
    return named;
}

auto resolve(const module_file& module, const instruction_pattern& pattern) -> resolved {
    resolved made{.steps = {}, .names = {}, .size_of_image = 0};
    made.steps.append_range(pattern.steps());
    made.size_of_image = module.view().size_of_image();
    for (const detail::step_pattern& step : made.steps) {
        made.names.push_back(names_of(step));
    }
    return made;
}

auto view_of(const ZydisDecodedOperand& operand) -> operand_view {
    operand_view made{.type = operand.type, .width = operand.size};
    // NOLINTBEGIN(cppcoreguidelines-pro-type-union-access): Zydis tags the union by operand.type.
    if (operand.type == ZYDIS_OPERAND_TYPE_REGISTER) {
        made.reg = operand.reg.value;
    } else if (operand.type == ZYDIS_OPERAND_TYPE_MEMORY) {
        made.base = operand.mem.base;
        made.index = operand.mem.index;
        made.scale = operand.mem.scale;
        made.displacement = operand.mem.disp.value;
    } else if (operand.type == ZYDIS_OPERAND_TYPE_IMMEDIATE) {
        made.is_relative = operand.imm.is_relative != 0;
        made.immediate = operand.imm.is_signed != 0 ? static_cast<u64>(operand.imm.value.s)
                                                    : operand.imm.value.u;
    }
    // NOLINTEND(cppcoreguidelines-pro-type-union-access)
    return made;
}

auto instructions_in(const module_file& module, pe::rva_range range)
    -> std::vector<instruction_view> {
    std::vector<instruction_view> code;
    detail::for_each_instruction(module, range, [&](u32 rva, const detail::decoded& found) {
        instruction_view made{
            .rva = rva,
            .next = rva + found.instruction.length,
            .mnemonic = found.instruction.mnemonic,
            .operand_count = found.instruction.operand_count_visible,
        };
        const usize kept =
            std::min(usize{made.operand_count}, usize{detail::step_pattern::max_operands});
        for (usize at = 0; at < kept; ++at) {
            made.operands.at(at) = view_of(found.operands.at(at));
        }
        code.push_back(made);
    });
    return code;
}

auto full_register(ZydisRegister reg) -> ZydisRegister {
    return ZydisRegisterGetLargestEnclosing(ZYDIS_MACHINE_MODE_LONG_64, reg);
}

// Binds the variable to the register the first time, then holds it to that register.
auto binds(bindings& state, u8 slot, ZydisRegister reg) -> bool {
    if (reg == ZYDIS_REGISTER_NONE) {
        return false;
    }
    ZydisRegister& bound = state.registers.at(slot);
    const ZydisRegister full = full_register(reg);
    if (bound == ZYDIS_REGISTER_NONE) {
        bound = full;
        return true;
    }
    return bound == full;
}

// One operand of an instruction held against one operand of a step.
struct operand_check {
    detail::operand_pattern pattern;
    operand_names names;
    operand_view actual;
    // The instruction after this one, which RIP-relative operands count from.
    u32 next = 0;
    u32 size_of_image = 0;
};

// The place `next + offset` names, as an RVA; absent outside the image.
auto target_of(const operand_check& check, i64 offset) -> std::optional<u64> {
    const i64 target = i64{check.next} + offset;
    if (target < 0 || target >= i64{check.size_of_image}) {
        return std::nullopt;
    }
    return static_cast<u64>(target);
}

auto width_mask(u16 width) -> u64 {
    return width == 0 || width >= 64 ? ~u64{0} : (u64{1} << width) - 1;
}

auto matches_base(const operand_check& check, bindings& state) -> bool {
    const detail::memory_pattern& memory = check.pattern.memory;
    switch (memory.base) {
    case detail::base_rule::any:
        return true;
    case detail::base_rule::exact_register:
        return check.actual.base == check.names.base;
    case detail::base_rule::variable:
        return binds(state, memory.base_slot, check.actual.base);
    case detail::base_rule::rip:
        return check.actual.base == ZYDIS_REGISTER_RIP;
    }
    LUCENT_UNREACHABLE();
}

auto matches_index(const operand_check& check, bindings& state) -> bool {
    const detail::memory_pattern& memory = check.pattern.memory;
    const bool is_scaled = check.actual.scale == memory.scale;
    switch (memory.index) {
    case detail::index_rule::none:
        return check.actual.index == ZYDIS_REGISTER_NONE;
    case detail::index_rule::any:
        return check.actual.index != ZYDIS_REGISTER_NONE && is_scaled;
    case detail::index_rule::exact_register:
        return check.actual.index == check.names.index && is_scaled;
    case detail::index_rule::variable:
        return binds(state, memory.index_slot, check.actual.index) && is_scaled;
    }
    LUCENT_UNREACHABLE();
}

auto matches_displacement(const operand_check& check, bindings& state) -> bool {
    const detail::memory_pattern& memory = check.pattern.memory;
    switch (memory.displacement) {
    case detail::displacement_rule::exact:
        return check.actual.displacement == memory.displacement_value;
    case detail::displacement_rule::any:
        return true;
    case detail::displacement_rule::capture: {
        if (check.actual.base != ZYDIS_REGISTER_RIP) {
            state.captures.at(memory.displacement_slot) =
                static_cast<u64>(check.actual.displacement);
            return true;
        }
        const std::optional<u64> target = target_of(check, check.actual.displacement);
        if (!target) {
            return false;
        }
        state.captures.at(memory.displacement_slot) = *target;
        return true;
    }
    }
    LUCENT_UNREACHABLE();
}

auto matches_memory(const operand_check& check, bindings& state) -> bool {
    return check.actual.type == ZYDIS_OPERAND_TYPE_MEMORY
           && matches_base(check, state)
           && matches_index(check, state)
           && matches_displacement(check, state);
}

auto captures_immediate(const operand_check& check, bindings& state) -> bool {
    if (check.actual.type != ZYDIS_OPERAND_TYPE_IMMEDIATE) {
        return false;
    }
    u64& slot = state.captures.at(check.pattern.slot);
    if (!check.actual.is_relative) {
        slot = check.actual.immediate;
        return true;
    }
    const std::optional<u64> target = target_of(check, static_cast<i64>(check.actual.immediate));
    if (!target) {
        return false;
    }
    slot = *target;
    return true;
}

auto matches_number(const operand_check& check) -> bool {
    const u64 mask = width_mask(check.actual.width);
    return check.actual.type == ZYDIS_OPERAND_TYPE_IMMEDIATE
           && !check.actual.is_relative
           && (check.actual.immediate & mask) == (static_cast<u64>(check.pattern.number) & mask);
}

auto matches_operand(const operand_check& check, bindings& state) -> bool {
    const bool is_register = check.actual.type == ZYDIS_OPERAND_TYPE_REGISTER;
    switch (check.pattern.rule) {
    case detail::operand_rule::any:
        return true;
    case detail::operand_rule::exact_register:
        return is_register && check.actual.reg == check.names.reg;
    case detail::operand_rule::variable:
        return is_register && binds(state, check.pattern.slot, check.actual.reg);
    case detail::operand_rule::number:
        return matches_number(check);
    case detail::operand_rule::capture:
        return captures_immediate(check, state);
    case detail::operand_rule::memory:
        return matches_memory(check, state);
    }
    LUCENT_UNREACHABLE();
}

auto matches_step(
    const resolved& pattern, usize step, const instruction_view& actual, bindings& state
) -> bool {
    const detail::step_pattern& wanted = pattern.steps.at(step);
    const step_names& names = pattern.names.at(step);
    if (!wanted.is_any_mnemonic && actual.mnemonic != names.mnemonic) {
        return false;
    }
    if (actual.operand_count != wanted.operand_count) {
        return false;
    }
    for (usize at = 0; at < wanted.operand_count; ++at) {
        const operand_check check{
            .pattern = wanted.operands.at(at),
            .names = names.operands.at(at),
            .actual = actual.operands.at(at),
            .next = actual.next,
            .size_of_image = pattern.size_of_image,
        };
        if (!matches_operand(check, state)) {
            return false;
        }
    }
    return true;
}

// How far one way of matching has got: the next step and instruction to look at, where the last
// matched instruction ended, and what it has bound and captured.
struct branch {
    usize step = 0;
    usize instruction = 0;
    u32 end = 0;
    bindings state;
};

// The match of the remaining steps that ends first. Each branch works on its own copy of the
// bindings, so a failed way leaves nothing behind.
// NOLINTNEXTLINE(misc-no-recursion): a gap tries each length in turn, at most max_steps deep.
auto match_from(const resolved& pattern, const std::vector<instruction_view>& code, branch from)
    -> std::optional<pattern_match> {
    if (from.step == pattern.steps.size()) {
        return pattern_match{.rva = 0, .end = from.end, .captures = from.state.captures};
    }
    if (pattern.steps.at(from.step).is_gap) {
        for (usize skipped = 0; skipped <= usize{instruction_pattern::max_gap}; ++skipped) {
            branch after = from;
            after.step = from.step + 1;
            after.instruction = from.instruction + skipped;
            if (after.instruction >= code.size()) {
                break;
            }
            if (std::optional<pattern_match> found = match_from(pattern, code, after)) {
                return found;
            }
        }
        return std::nullopt;
    }
    if (from.instruction >= code.size()) {
        return std::nullopt;
    }
    const instruction_view& actual = code.at(from.instruction);
    branch after = from;
    if (!matches_step(pattern, from.step, actual, after.state)) {
        return std::nullopt;
    }
    after.step = from.step + 1;
    after.instruction = from.instruction + 1;
    after.end = actual.next;
    return match_from(pattern, code, after);
}

auto matches_of(const resolved& pattern, const std::vector<instruction_view>& code)
    -> std::vector<pattern_match> {
    std::vector<pattern_match> found;
    for (usize start = 0; start < code.size(); ++start) {
        branch first{};
        first.instruction = start;
        std::optional<pattern_match> one = match_from(pattern, code, first);
        if (one) {
            one->rva = code.at(start).rva;
            found.push_back(*one);
        }
    }
    return found;
}
}

auto matches_in(const module_file& module, pe::rva_range range, const instruction_pattern& pattern)
    -> std::vector<pattern_match> {
    return matches_of(resolve(module, pattern), instructions_in(module, range));
}

auto matches_in_code(const module_file& module, const instruction_pattern& pattern)
    -> std::vector<pattern_match> {
    const resolved searched = resolve(module, pattern);
    std::vector<pattern_match> found;
    for (const pe::rva_range range : detail::code_ranges(module)) {
        found.append_range(matches_of(searched, instructions_in(module, range)));
    }
    return found;
}

auto captured(std::span<const pattern_match> matches, isize capture) -> std::vector<u64> {
    std::vector<u64> values;
    values.reserve(matches.size());
    for (const pattern_match& one : matches) {
        values.push_back(one.captures.at(narrow<usize>(capture)));
    }
    return values;
}

}
