#include <lucent/kit/fact_resolve.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
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

// What a resolve decides for one fact before any reader can see it.
struct decision {
    fact_status status = fact_status::unresolved;
    u64 value = 0;
};

// One linked fact, whether this resolve may write it, and what it decided for it.
struct entry {
    u64 key = 0;
    const fact_record* record = nullptr;
    bool is_writable = false;
    std::optional<decision> decided;
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

// Counting stops at the first entry that isn't code, at one that can't be read, or at the sanity
// bound.
auto vtable_length(const module_image& image, uptr vtable) -> usize {
    const foreign::memory_source own = foreign::memory_source::this_process();
    const foreign::foreign_ptr<u64> first{.address = vtable};
    for (const usize index : std::views::iota(usize{0}, max_vtable_length)) {
        const result<u64> entry = foreign::read(own, foreign::element(first, narrow<isize>(index)));
        if (!entry || !is_code(image, *entry)) {
            return index;
        }
    }
    return max_vtable_length;
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

auto find_entry(std::span<const entry> index, u64 key) -> const entry* {
    const auto found = std::ranges::lower_bound(index, key, {}, &entry::key);
    return found == index.end() || found->key != key ? nullptr : &*found;
}

// The resolving thread is the only writer, so it reads what's published without ordering.
auto published(const fact_record& record) -> decision {
    return decision{.status = record.status, .value = record.value};
}

// What a fact will be once this resolve publishes: what it decided, or else what's published.
auto outcome_of(const entry& fact) -> decision {
    return fact.decided.value_or(published(*fact.record));
}

// The checks that need another fact: a field against its owner's size, a slot against its vtable.
// A bound naming no fact is a declaration typo: our own bug.
auto passes_bound(
    const entry& checked, std::span<const entry> index, std::span<const module_image> modules
) -> bool {
    const fact_record& record = *checked.record;
    if (record.bound == 0 || (record.kind != fact_kind::field && record.kind != fact_kind::slot)) {
        return true;
    }
    const entry* const bound = find_entry(index, record.bound);
    LUCENT_INVARIANT(bound != nullptr);
    const decision limit = outcome_of(*bound);
    if (limit.status != fact_status::resolved) {
        return false;
    }
    const u64 value = outcome_of(checked).value;
    if (record.kind == fact_kind::field) {
        return value + record.width <= limit.value;
    }
    const module_image* const image = find_module(modules, bound->record->module);
    return image != nullptr && value < vtable_length(*image, limit.value);
}

auto index_by_key(
    std::span<const fact_record> records, stdx::function_ref<bool(const fact_record&)> is_writable
) -> std::vector<entry> {
    std::vector<entry> index;
    index.reserve(records.size());
    for (const fact_record& record : records) {
        if (record.key != 0) {
            index.push_back(
                entry{
                    .key = record.key,
                    .record = &record,
                    .is_writable = is_writable(record),
                    .decided = std::nullopt,
                }
            );
        }
    }
    std::ranges::sort(index, {}, &entry::key);
    const bool has_duplicate = std::ranges::adjacent_find(index, {}, &entry::key) != index.end();
    LUCENT_INVARIANT(!has_duplicate);
    return index;
}

struct decisions {
    std::vector<entry> index;
    // Values for facts this image doesn't link.
    u32 unknown = 0;
};

// Decides every writable fact a value arrived for, without publishing anything.
auto decide(
    std::vector<entry> index,
    std::span<const fact_value> values,
    std::span<const module_image> modules
) -> decisions {
    u32 unknown = 0;
    for (const fact_value& given : values) {
        const auto found = std::ranges::lower_bound(index, given.key, {}, &entry::key);
        if (found == index.end() || found->key != given.key) {
            ++unknown;
            continue;
        }
        if (!found->is_writable) {
            continue;
        }
        const std::optional<u64> stored = checked_value(*found->record, given.value, modules);
        found->decided = decision{
            .status = stored ? fact_status::resolved : fact_status::rejected,
            .value = stored.value_or(0),
        };
    }
    // Bounds only after every first check: a bound may be declared after what it bounds.
    for (entry& fact : index) {
        const bool is_resolved = fact.decided && fact.decided->status == fact_status::resolved;
        if (is_resolved && !passes_bound(fact, index, modules)) {
            fact.decided = decision{.status = fact_status::rejected, .value = 0};
        }
    }
    return decisions{.index = std::move(index), .unknown = unknown};
}

// Value before status, the status with release: a reader that loads the status with acquire
// (status_of) and sees resolved sees this value. Only a fact no reader may use yet is written: an
// unresolved one, or any before attach. Safe points will replace this: values staged off to the
// side and published only between ticks, with the section read-only otherwise.
auto publish(const fact_record& record, decision decided) -> void {
    record.value = decided.value;
    std::atomic_ref<fact_status>{record.status}.store(decided.status, std::memory_order_release);
}

auto publish_all(std::span<const entry> index) -> void {
    for (const entry& fact : index) {
        if (fact.decided) {
            publish(*fact.record, *fact.decided);
        }
    }
}

// Counts the writable facts only, as they are once published.
auto count(std::span<const entry> index) -> resolve_report {
    resolve_report report;
    for (const entry& fact : index) {
        if (!fact.is_writable) {
            continue;
        }
        switch (outcome_of(fact).status) {
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

auto resolve_decided(decisions decided) -> resolve_report {
    resolve_report report = count(decided.index);
    report.unknown = decided.unknown;
    publish_all(decided.index);
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
    for (const fact_record& record : records) {
        publish(record, decision{.status = fact_status::unresolved, .value = 0});
    }
    std::vector<entry> index = index_by_key(records, [](const fact_record&) { return true; });
    return resolve_decided(decide(std::move(index), values, modules));
}

auto resolve_late(const late_resolve_request& request) -> resolve_report {
    std::vector<entry> index = index_by_key(request.records, [&](const fact_record& record) {
        return record.status == fact_status::unresolved
               && std::ranges::find(request.late, record.module) != request.late.end();
    });
    return resolve_decided(decide(std::move(index), request.values, request.modules));
}

}
