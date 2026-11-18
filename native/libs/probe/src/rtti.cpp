#include <lucent/probe/rtti.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>
#include <lucent/probe/strings.hpp>

#include "ranges.hpp"

// MSVC's x64 RTTI, which clang-cl emits the same way.
// build: MSVC x64 ABI (complete object locator signature 1, image-relative fields)
// found: _RTTICompleteObjectLocator and TypeDescriptor in MSVC's ehdata.h and rttidata.h; checked
// against tests/fixtures/game.cpp built with /GR
// breaks: rtti_vtables_of finds nothing for a class that has RTTI; the rtti tests fail
namespace lucent::probe {
namespace {

struct raw_locator {
    u32 signature;
    u32 subobject_offset;
    u32 constructor_displacement;
    u32 type_descriptor;
    u32 class_descriptor;
    u32 self;
};

static_assert(sizeof(raw_locator) == 24, "_RTTICompleteObjectLocator is 24 bytes on x64");

// Image-relative fields, plus the self field that lets code find the image base from a locator.
constexpr u32 locator_signature_x64 = 1;
// A TypeDescriptor is the type_info vtable pointer, a spare pointer, then the decorated name.
constexpr u32 type_name_offset = 16;
// The slot before a vtable's first function points at its locator.
constexpr u32 pointer_size = sizeof(u64);

struct locator {
    u32 rva = 0;
    u32 subobject_offset = 0;
};

// ".?AV" (class) or ".?AU" (struct), then the name's parts innermost first, each ending in '@'.
auto decorated_names(std::string_view name) -> std::vector<std::string> {
    if (name.starts_with(".?A")) {
        return {std::string{name}};
    }
    std::vector<std::string_view> parts;
    for (const auto part : name | std::views::split(std::string_view{"::"})) {
        parts.emplace_back(part);
    }
    std::string nested;
    for (const std::string_view part : parts | std::views::reverse) {
        nested += part;
        nested += '@';
    }
    return {".?AV" + nested + "@", ".?AU" + nested + "@"};
}

auto type_descriptors(const module_file& module, std::string_view name) -> std::vector<u32> {
    std::vector<u32> descriptors;
    for (const std::string& decorated : decorated_names(name)) {
        for (const u32 text : string_rvas(module, decorated)) {
            if (text >= type_name_offset) {
                descriptors.push_back(text - type_name_offset);
            }
        }
    }
    return descriptors;
}

auto locator_at(std::span<const std::byte> bytes, usize offset) -> std::optional<raw_locator> {
    if (offset + sizeof(raw_locator) > bytes.size()) {
        return std::nullopt;
    }
    std::array<std::byte, sizeof(raw_locator)> raw{};
    std::ranges::copy(bytes.subspan(offset, sizeof(raw_locator)), raw.begin());
    return std::bit_cast<raw_locator>(raw);
}

auto is_locator_for(const raw_locator& candidate, u32 rva, u32 descriptor) -> bool {
    return candidate.signature == locator_signature_x64
           && candidate.self == rva
           && candidate.type_descriptor == descriptor;
}

auto locators_of(const module_file& module, u32 descriptor) -> std::vector<locator> {
    std::vector<locator> found;
    for (const pe::rva_range range : detail::data_sections(module)) {
        const std::optional<std::span<const std::byte>> bytes = module.bytes_at(range);
        if (!bytes) {
            continue;
        }
        for (usize offset = 0; offset < bytes->size(); offset += alignof(raw_locator)) {
            const u32 rva = range.rva + narrow<u32>(offset);
            const std::optional<raw_locator> candidate = locator_at(*bytes, offset);
            if (candidate && is_locator_for(*candidate, rva, descriptor)) {
                found.push_back({.rva = rva, .subobject_offset = candidate->subobject_offset});
            }
        }
    }
    return found;
}

auto vtables_pointing_at(const module_file& module, const locator& target)
    -> std::vector<rtti_vtable> {
    std::vector<rtti_vtable> found;
    const u64 address = module.view().image_base() + target.rva;
    for (const pe::rva_range range : detail::data_sections(module)) {
        for (u32 offset = 0; offset + pointer_size <= range.size; offset += pointer_size) {
            if (module.u64_at(range.rva + offset) == address) {
                found.push_back({
                    .rva = range.rva + offset + pointer_size,
                    .subobject_offset = target.subobject_offset,
                });
            }
        }
    }
    return found;
}

}

auto rtti_vtables_of(const module_file& module, std::string_view name) -> std::vector<rtti_vtable> {
    std::vector<rtti_vtable> found;
    for (const u32 descriptor : type_descriptors(module, name)) {
        for (const locator& each : locators_of(module, descriptor)) {
            found.append_range(vtables_pointing_at(module, each));
        }
    }
    std::ranges::sort(found, {}, &rtti_vtable::subobject_offset);
    return found;
}

}
