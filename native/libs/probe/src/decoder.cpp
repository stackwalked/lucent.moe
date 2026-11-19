#include "decoder.hpp"

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <Zycore/Status.h>
#include <Zydis/Decoder.h>
#include <Zydis/DecoderTypes.h>
#include <Zydis/SharedTypes.h>

#include <lucent/core/narrow.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/module_file.hpp>

#include "ranges.hpp"

namespace lucent::probe::detail {
namespace {

constexpr std::byte int3{0xcc};

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

}

auto for_each_instruction(
    const module_file& module,
    pe::rva_range range,
    stdx::function_ref<void(u32, const decoded&)> on_instruction
) -> void {
    const std::optional<std::span<const std::byte>> code = module.bytes_at(range);
    if (!code) {
        return;
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
        on_instruction(range.rva + narrow<u32>(offset), *found);
        offset += found->instruction.length;
    }
}

auto code_ranges(const module_file& module) -> std::vector<pe::rva_range> {
    std::vector<pe::rva_range> ranges;
    for (const pe::rva_range section : code_sections(module)) {
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

}
