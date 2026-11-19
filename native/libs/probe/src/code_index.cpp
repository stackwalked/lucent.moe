#include <lucent/probe/code_index.hpp>

#include <algorithm>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

#include "decoder.hpp"

namespace lucent::probe {
namespace {

// The target as an RVA: absent when it falls outside the image.
auto target_rva(const module_file& module, u32 next, i64 displacement) -> std::optional<u32> {
    const i64 target = i64{next} + displacement;
    if (target < 0 || target >= i64{module.view().size_of_image()}) {
        return std::nullopt;
    }
    return static_cast<u32>(target);
}

auto branch_kind(const ZydisDecodedInstruction& instruction) -> reference_kind {
    if (instruction.mnemonic == ZYDIS_MNEMONIC_CALL) {
        return reference_kind::call;
    }
    if (instruction.mnemonic == ZYDIS_MNEMONIC_JMP) {
        return reference_kind::jump;
    }
    return reference_kind::branch;
}

auto memory_kind(const ZydisDecodedInstruction& instruction, const ZydisDecodedOperand& operand)
    -> reference_kind {
    if (instruction.mnemonic == ZYDIS_MNEMONIC_LEA) {
        return reference_kind::address;
    }
    const u32 writes = static_cast<u32>(ZYDIS_OPERAND_ACTION_MASK_WRITE);
    return (u32{operand.actions} & writes) != 0 ? reference_kind::store : reference_kind::load;
}

// The reference one operand makes, if it names a place by its distance from the next instruction.
// build: Zydis 4.1 (vcpkg baseline 8f0be20f); the operand's union member is chosen by its type.
// found: Zydis DecoderTypes.h, ZydisDecodedOperand
// breaks: references are missed or misread; the probe tests fail
auto reference_of(
    const module_file& module,
    u32 source,
    const detail::decoded& found,
    const ZydisDecodedOperand& operand
) -> std::optional<reference> {
    const u32 next = source + found.instruction.length;
    std::optional<u32> target;
    reference_kind kind = reference_kind::call;
    // NOLINTBEGIN(cppcoreguidelines-pro-type-union-access): Zydis tags the union by operand.type.
    if (operand.type == ZYDIS_OPERAND_TYPE_IMMEDIATE && operand.imm.is_relative != 0) {
        target = target_rva(module, next, operand.imm.value.s);
        kind = branch_kind(found.instruction);
    } else if (operand.type == ZYDIS_OPERAND_TYPE_MEMORY
               && operand.mem.base == ZYDIS_REGISTER_RIP) {
        target = target_rva(module, next, operand.mem.disp.value);
        kind = memory_kind(found.instruction, operand);
    }
    // NOLINTEND(cppcoreguidelines-pro-type-union-access)
    if (!target) {
        return std::nullopt;
    }
    return reference{.source = source, .target = *target, .kind = kind};
}

auto by_target_then_source(const reference& left, const reference& right) -> bool {
    return std::pair{left.target, left.source} < std::pair{right.target, right.source};
}

}

auto references_in(const module_file& module, pe::rva_range range) -> std::vector<reference> {
    std::vector<reference> named;
    detail::for_each_instruction(module, range, [&](u32 source, const detail::decoded& found) {
        const auto visible =
            std::span{found.operands}.first(found.instruction.operand_count_visible);
        for (const ZydisDecodedOperand& operand : visible) {
            if (const std::optional<reference> one = reference_of(module, source, found, operand)) {
                named.push_back(*one);
            }
        }
    });
    return named;
}

code_index::code_index(std::vector<reference> by_target)
    : m_by_target{std::move(by_target)} {}

auto code_index::build(const module_file& module) -> code_index {
    std::vector<reference> all;
    for (const pe::rva_range range : detail::code_ranges(module)) {
        all.append_range(references_in(module, range));
    }
    std::ranges::sort(all, by_target_then_source);
    return code_index{std::move(all)};
}

auto code_index::references_to(u32 target) const -> std::span<const reference> {
    const std::span<const reference> all = m_by_target;
    const auto first = std::ranges::lower_bound(all, target, {}, &reference::target);
    const auto last = std::ranges::upper_bound(first, all.end(), target, {}, &reference::target);
    return all.subspan(narrow<usize>(first - all.begin()), narrow<usize>(last - first));
}

auto code_index::size() const -> isize {
    return narrow<isize>(m_by_target.size());
}

}
