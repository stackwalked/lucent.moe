#include "classes.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/probe/navigation.hpp>
#include <lucent/probe/rtti.hpp>

#include "code.hpp"

namespace lucent::finder {

namespace {

// UNWIND_INFO: the version and flags byte, the prolog size, the count of 2-byte unwind codes
// (padded to an even count), the frame register; a chained part's parent RUNTIME_FUNCTION follows
// the codes.
// build: the x64 ABI (Microsoft's "x64 exception handling")
// found: client.dll's split functions, e.g. FrameStageNotify at +0xb63350 in parts at +0xb634eb
// and +0xb6363e chained to it
// breaks: never for a valid image; an image without chains has every part its own function
constexpr u8 chained_flag = 0x4;
constexpr u32 header_size = 4;
constexpr u32 code_size = 2;
constexpr isize max_chain = 32;

static_assert(sizeof(pe::runtime_function) == 12, "RUNTIME_FUNCTION, as the image holds it");

auto parent_of(const probe::module_file& module, const pe::runtime_function& part)
    -> std::optional<pe::runtime_function> {
    const std::optional<std::span<const std::byte>> header =
        module.bytes_at({.rva = part.unwind_info, .size = header_size});
    if (!header) {
        return std::nullopt;
    }
    const auto flags = static_cast<u8>(std::to_integer<u8>(header->front()) >> 3U);
    if ((flags & chained_flag) == 0) {
        return std::nullopt;
    }
    const u32 codes = std::to_integer<u8>(header->subspan(2).front());
    const u32 parent_at = part.unwind_info + header_size + (((codes + 1U) & ~1U) * code_size);
    const std::optional<std::span<const std::byte>> parent =
        module.bytes_at({.rva = parent_at, .size = sizeof(pe::runtime_function)});
    if (!parent) {
        return std::nullopt;
    }
    std::array<std::byte, sizeof(pe::runtime_function)> held{};
    std::ranges::copy(*parent, held.begin());
    return std::bit_cast<pe::runtime_function>(held);
}

}

auto function_start(const probe::module_file& module, const pe::runtime_function& part) -> u32 {
    pe::runtime_function current = part;
    for (isize step = 0; step < max_chain; ++step) {
        const std::optional<pe::runtime_function> parent = parent_of(module, current);
        if (!parent) {
            break;
        }
        current = *parent;
    }
    return current.begin;
}

auto parts_of(const probe::module_file& module, u32 start) -> std::vector<pe::runtime_function> {
    const std::span<const pe::runtime_function> functions = module.functions();
    const auto first = std::ranges::lower_bound(functions, start, {}, &pe::runtime_function::begin);
    std::vector<pe::runtime_function> parts;
    if (first == functions.end() || first->begin != start) {
        return parts;
    }
    parts.push_back(*first);
    for (auto next = first + 1; next != functions.end() && std::ssize(parts) < max_chain; ++next) {
        if (function_start(module, *next) != start) {
            break;
        }
        parts.push_back(*next);
    }
    return parts;
}

auto primary_vtable(const probe::module_file& module, std::string_view name) -> std::optional<u32> {
    for (const probe::rtti_vtable& vtable : probe::rtti_vtables_of(module, name)) {
        if (vtable.subobject_offset == 0) {
            return vtable.rva;
        }
    }
    return std::nullopt;
}

auto slots_of(const probe::module_file& module, std::string_view name) -> std::vector<u32> {
    const std::optional<u32> vtable = primary_vtable(module, name);
    if (!vtable) {
        return {};
    }
    return probe::vtable_functions(module, *vtable);
}

auto slot_functions(const probe::module_file& module, std::string_view name)
    -> std::vector<pe::runtime_function> {
    std::vector<pe::runtime_function> parts;
    for (const u32 slot : slots_of(module, name)) {
        parts.append_range(parts_of(module, slot));
    }
    return parts;
}

auto slot_index(const probe::module_file& module, std::string_view name, u32 entry)
    -> probe::finding {
    std::vector<u32> indices;
    for (const auto [index, slot] : std::views::enumerate(slots_of(module, name))) {
        if (slot == entry) {
            indices.push_back(static_cast<u32>(index));
        }
    }
    if (indices.size() > 1) {
        return std::unexpected(probe::miss::ambiguous);
    }
    return probe::one(indices);
}

auto callees_of(const probe::module_file& module, std::span<const pe::runtime_function> callers)
    -> std::vector<pe::runtime_function> {
    std::vector<u32> targets;
    for (const pe::runtime_function& caller : callers) {
        const pe::rva_range code{.rva = caller.begin, .size = caller.end - caller.begin};
        for (const probe::reference& made : probe::references_in(module, code)) {
            if (made.kind == probe::reference_kind::call
                || made.kind == probe::reference_kind::jump) {
                targets.push_back(made.target);
            }
        }
    }
    std::ranges::sort(targets);
    const auto [last, end] = std::ranges::unique(targets);
    targets.erase(last, end);
    std::vector<pe::runtime_function> callees;
    for (const u32 target : targets) {
        const std::optional<pe::runtime_function> holder = module.function_containing(target);
        if (holder && holder->begin == target) {
            callees.append_range(parts_of(module, target));
        }
    }
    return callees;
}

auto captured_in_class(
    const probe::module_file& module,
    std::string_view name,
    const probe::instruction_pattern& pattern,
    isize capture
) -> probe::finding {
    return probe::one(captured_in(module, slot_functions(module, name), pattern, capture));
}

}
