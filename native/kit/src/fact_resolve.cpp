#include <lucent/kit/fact_resolve.hpp>

#include <algorithm>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <tuple>
#include <vector>

#include <Windows.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/os/address_range.hpp>
#include <lucent/pe/image_view.hpp>

#include "time_date_stamp.hpp"

namespace lucent::kit {
namespace {

// Sanity bounds where the image itself gives none.
constexpr u64 max_field_offset = u64{1} << 20U;
constexpr usize max_vtable_length = 4096;
constexpr u64 pointer_alignment = 8;

struct keyed {
    u64 key = 0;
    const fact_record* record = nullptr;
};

auto find_module(std::span<const module_image> modules, u8 index) -> const module_image* {
    const auto found = std::ranges::find(modules, index, &module_image::index);
    return found == modules.end() ? nullptr : &*found;
}

auto section_of(const module_image& image, u64 rva, u64 size) -> const image_section* {
    const auto found = std::ranges::find_if(image.sections, [&](const image_section& section) {
        return rva >= section.rva && rva + size <= u64{section.rva} + section.size;
    });
    return found == image.sections.end() ? nullptr : &*found;
}

auto is_code(const module_image& image, u64 address) -> bool {
    if (address < image.base) {
        return false;
    }
    const image_section* const section = section_of(image, address - image.base, 1);
    return section != nullptr && section->is_executable;
}

// .pdata knows every function except leaves, which have no unwind data: an address inside a
// function .pdata knows must be its start; one it doesn't know passes on its section alone.
auto is_function_start(const module_image& image, uptr address) -> bool {
    DWORD64 owner = 0;
    const RUNTIME_FUNCTION* const function = RtlLookupFunctionEntry(address, &owner, nullptr);
    if (function == nullptr) {
        return true;
    }
    return owner == image.base && owner + function->BeginAddress == address;
}

// A vtable's entries are foreign memory: read under contain(). Counting stops at the first entry
// that isn't code, at a fault, or at the sanity bound.
auto vtable_length(const module_image& image, uptr vtable) -> usize {
    usize length = 0;
    std::ignore = contain([&] {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // stops at the first non-code
        const std::span<const u64> entries{std::bit_cast<const u64*>(vtable), max_vtable_length};
#pragma clang diagnostic pop
        for (const u64 entry : entries) {
            if (!is_code(image, entry)) {
                return;
            }
            ++length;
        }
    });
    return length;
}

// The address kinds' checks against their module's image; the absolute address when one passes.
auto checked_address(const fact_record& record, u64 rva, const module_image& image)
    -> std::optional<u64> {
    const uptr address = image.base + rva;
    const u64 extent = record.kind == fact_kind::vtable ? pointer_alignment : 1;
    const image_section* const section = section_of(image, rva, extent);
    if (section == nullptr) {
        return std::nullopt;
    }
    bool passes = false;
    switch (record.kind) {
    case fact_kind::method:
        passes = section->is_executable && is_function_start(image, address);
        break;
    case fact_kind::global:
        passes =
            !section->is_executable && (record.alignment <= 1 || address % record.alignment == 0);
        break;
    case fact_kind::vtable:
        passes = !section->is_executable
                 && !section->is_writable
                 && address % pointer_alignment == 0
                 && vtable_length(image, address) > 0;
        break;
    case fact_kind::slot:
    case fact_kind::field:
    case fact_kind::value:
        break;
    }
    return passes ? std::optional<u64>{address} : std::nullopt;
}

// The kind's check that needs only the value and the image; the stored value when it passes.
auto checked_value(const fact_record& record, u64 raw, std::span<const module_image> modules)
    -> std::optional<u64> {
    switch (record.kind) {
    case fact_kind::method:
    case fact_kind::global:
    case fact_kind::vtable: {
        const module_image* const image = find_module(modules, record.module);
        return image == nullptr ? std::nullopt : checked_address(record, raw, *image);
    }
    case fact_kind::slot:
        return raw < max_vtable_length ? std::optional<u64>{raw} : std::nullopt;
    case fact_kind::field: {
        const bool is_aligned = record.alignment <= 1 || raw % record.alignment == 0;
        return raw <= max_field_offset && is_aligned ? std::optional<u64>{raw} : std::nullopt;
    }
    case fact_kind::value: {
        const auto number = static_cast<i64>(raw);
        const value_range range = unpack_range(record.bound);
        return number >= range.min && number <= range.max ? std::optional<u64>{raw} : std::nullopt;
    }
    }
    return std::nullopt;
}

auto find_record(std::span<const keyed> index, u64 key) -> const fact_record* {
    const auto found = std::ranges::lower_bound(index, key, {}, &keyed::key);
    return found == index.end() || found->key != key ? nullptr : found->record;
}

// The checks that need another fact: a field against its owner's size, a slot against its vtable.
// A bound naming no fact is a declaration typo: our own bug.
auto passes_bound(
    const fact_record& record, std::span<const keyed> index, std::span<const module_image> modules
) -> bool {
    if (record.bound == 0 || (record.kind != fact_kind::field && record.kind != fact_kind::slot)) {
        return true;
    }
    const fact_record* const bound = find_record(index, record.bound);
    LUCENT_INVARIANT(bound != nullptr);
    if (bound->status != fact_status::resolved) {
        return false;
    }
    if (record.kind == fact_kind::field) {
        return record.value + record.width <= bound->value;
    }
    const module_image* const image = find_module(modules, bound->module);
    return image != nullptr && record.value < vtable_length(*image, bound->value);
}

auto index_by_key(std::span<const fact_record> records) -> std::vector<keyed> {
    std::vector<keyed> index;
    index.reserve(records.size());
    for (const fact_record& record : records) {
        if (record.key != 0) {
            index.push_back(keyed{.key = record.key, .record = &record});
        }
    }
    std::ranges::sort(index, {}, &keyed::key);
    const bool has_duplicate = std::ranges::adjacent_find(index, {}, &keyed::key) != index.end();
    LUCENT_INVARIANT(!has_duplicate);
    return index;
}

auto count(std::span<const fact_record> records) -> resolve_report {
    resolve_report report;
    for (const fact_record& record : records) {
        if (record.key == 0) {
            continue;
        }
        switch (record.status) {
        case fact_status::resolved:
            ++report.resolved;
            break;
        case fact_status::rejected:
            ++report.rejected;
            break;
        case fact_status::unresolved:
            ++report.unresolved;
            break;
        }
    }
    return report;
}

}

auto image_at(u8 index, uptr base) -> result<module_image> {
    const os::address_range range = LUCENT_TRY(os::allocation_containing(base));
    if (range.begin != base) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    module_image image{
        .index = index,
        .base = base,
        .size = range.end - range.begin,
        .sections = {},
        .time_date_stamp = 0,
        .size_of_image = 0,
    };
    bool is_parsed = false;
    const contained<void> read = contain([&] {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // the allocation's own extent
        const std::span<const std::byte> bytes{std::bit_cast<const std::byte*>(base), image.size};
#pragma clang diagnostic pop
        const result<pe::image_view> view = pe::image_view::parse(bytes, pe::layout::mapped);
        if (!view) {
            return;
        }
        const result<u32> stamp = detail::time_date_stamp_of(*view);
        if (!stamp) {
            return;
        }
        image.time_date_stamp = *stamp;
        image.size_of_image = view->size_of_image();
        for (const pe::section& stored : view->sections()) {
            image.sections.push_back(
                image_section{
                    .rva = stored.virtual_address,
                    .size = pe::mapped_size_of(stored),
                    .is_executable = stored.access.is_executable,
                    .is_writable = stored.access.is_writable,
                }
            );
        }
        is_parsed = true;
    });
    if (!read || !is_parsed) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    return image;
}

auto resolve(
    std::span<const fact_record> records,
    std::span<const fact_value> values,
    std::span<const module_image> modules
) -> resolve_report {
    const std::vector<keyed> index = index_by_key(records);
    for (const fact_record& record : records) {
        record.status = fact_status::unresolved;
        record.value = 0;
    }
    u32 unknown = 0;
    for (const fact_value& given : values) {
        const fact_record* const record = find_record(index, given.key);
        if (record == nullptr) {
            ++unknown;
            continue;
        }
        const std::optional<u64> stored = checked_value(*record, given.value, modules);
        record->status = stored ? fact_status::resolved : fact_status::rejected;
        record->value = stored.value_or(0);
    }
    // Bounds only after every first check: a bound may be declared after what it bounds.
    for (const fact_record& record : records) {
        if (record.status == fact_status::resolved && !passes_bound(record, index, modules)) {
            record.status = fact_status::rejected;
            record.value = 0;
        }
    }
    resolve_report report = count(records);
    report.unknown = unknown;
    return report;
}

}
