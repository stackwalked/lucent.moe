#include <lucent/probe/code_index.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <Zycore/Status.h>
#include <Zydis/Decoder.h>
#include <Zydis/DecoderTypes.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {
namespace {

constexpr std::byte int3{0xcc};

struct decoded {
    ZydisDecodedInstruction instruction{};
    std::array<ZydisDecodedOperand, ZYDIS_MAX_OPERAND_COUNT> operands{};
};

auto decoder_for_x64() -> ZydisDecoder {
    ZydisDecoder decoder{};
    const ZyanStatus status =
        ZydisDecoderInit(&decoder, ZYDIS_MACHINE_MODE_LONG_64, ZYDIS_STACK_WIDTH_64);
    LUCENT_INVARIANT(ZYAN_SUCCESS(status));
    return decoder;
}

auto decode(const ZydisDecoder& decoder, std::span<const std::byte> code)
    -> std::optional<decoded> {
    decoded result{};
    const ZyanStatus status = ZydisDecoderDecodeFull(
        &decoder, code.data(), code.size(), &result.instruction, result.operands.data()
    );
    if (!ZYAN_SUCCESS(status)) {
        return std::nullopt;
    }
    return result;
}

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
    const module_file& module, u32 source, const decoded& found, const ZydisDecodedOperand& operand
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

auto references_of(const module_file& module, u32 source, const decoded& found)
    -> std::vector<reference> {
    std::vector<reference> named;
    const auto visible = std::span{found.operands}.first(found.instruction.operand_count_visible);
    for (const ZydisDecodedOperand& operand : visible) {
        if (const std::optional<reference> one = reference_of(module, source, found, operand)) {
            named.push_back(*one);
        }
    }
    return named;
}

auto executable_ranges(const module_file& module) -> std::vector<pe::rva_range> {
    std::vector<pe::rva_range> ranges;
    for (const pe::section& stored : module.view().sections()) {
        if (stored.access.is_executable) {
            ranges.push_back({.rva = stored.virtual_address, .size = pe::mapped_size_of(stored)});
        }
    }
    return ranges;
}

// Each listed function, and each gap between them, as its own range: a listed function starts a
// fresh decode, so a misdecoded gap can't run into the code after it.
auto code_ranges(const module_file& module) -> std::vector<pe::rva_range> {
    std::vector<pe::rva_range> ranges;
    for (const pe::rva_range section : executable_ranges(module)) {
        const u32 section_end = section.rva + section.size;
        u32 cursor = section.rva;
        for (const pe::runtime_function& function : module.functions()) {
            if (function.begin < cursor || function.end > section_end) {
                continue;
            }
            if (function.begin > cursor) {
                ranges.push_back({.rva = cursor, .size = function.begin - cursor});
            }
            ranges.push_back({.rva = function.begin, .size = function.end - function.begin});
            cursor = function.end;
        }
        if (cursor < section_end) {
            ranges.push_back({.rva = cursor, .size = section_end - cursor});
        }
    }
    return ranges;
}

auto by_target_then_source(const reference& left, const reference& right) -> bool {
    return std::pair{left.target, left.source} < std::pair{right.target, right.source};
}

}

auto references_in(const module_file& module, pe::rva_range range) -> std::vector<reference> {
    std::vector<reference> named;
    const std::optional<std::span<const std::byte>> code = module.bytes_at(range);
    if (!code) {
        return named;
    }
    const ZydisDecoder decoder = decoder_for_x64();
    usize offset = 0;
    while (offset < code->size()) {
        const std::span<const std::byte> rest = code->subspan(offset);
        const std::optional<decoded> found =
            rest.front() == int3 ? std::nullopt : decode(decoder, rest);
        if (!found) {
            ++offset;
            continue;
        }
        named.append_range(references_of(module, range.rva + narrow<u32>(offset), *found));
        offset += found->instruction.length;
    }
    return named;
}

code_index::code_index(std::vector<reference> by_target)
    : m_by_target{std::move(by_target)} {}

auto code_index::build(const module_file& module) -> code_index {
    std::vector<reference> all;
    for (const pe::rva_range range : code_ranges(module)) {
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
