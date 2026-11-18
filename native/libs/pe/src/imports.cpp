#include <lucent/pe/imports.hpp>

#include <expected>
#include <optional>
#include <ranges>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>

#include "format.hpp"

namespace lucent::pe {
namespace {

// Bounds on walks over terminator-ended tables, far above anything a linker emits.
constexpr u32 max_import_modules = 4096;
constexpr u32 max_entries_per_module = 65'536;

auto is_terminator(const detail::raw_import_descriptor& descriptor) -> bool {
    return descriptor.name == 0 && descriptor.address_table == 0;
}

auto target_of(const image_view& image, u64 thunk) -> result<import_target> {
    if ((thunk & detail::import_by_ordinal) != 0) {
        return export_ordinal{static_cast<u16>(thunk & 0xffffU)};
    }
    if (thunk > image.size_of_image()) {
        return std::unexpected(detail::malformed);
    }
    const auto rva = static_cast<u32>(thunk);
    return import_by_name{
        .name = LUCENT_TRY(image.string_at(rva + narrow<u32>(sizeof(u16)))),
        .hint = LUCENT_TRY(detail::read_rva<u16>(image, rva)),
    };
}

auto entries_of(const image_view& image, const detail::raw_import_descriptor& descriptor)
    -> result<std::vector<import_entry>> {
    // The lookup table names what to import; the address table is where results go. Some linkers
    // leave the lookup table out, and then the address table names them too.
    const u32 lookup =
        descriptor.lookup_table != 0 ? descriptor.lookup_table : descriptor.address_table;
    std::vector<import_entry> entries;
    for (const u32 index : std::views::iota(u32{0}, max_entries_per_module)) {
        const u32 step = index * narrow<u32>(sizeof(u64));
        const u64 thunk = LUCENT_TRY(detail::read_rva<u64>(image, lookup + step));
        if (thunk == 0) {
            return entries;
        }
        entries.push_back(
            import_entry{
                .target = LUCENT_TRY(target_of(image, thunk)),
                .slot_rva = descriptor.address_table + step,
            }
        );
    }
    return std::unexpected(detail::malformed);
}

}

auto imports_of(const image_view& image) -> result<std::vector<import_module>> {
    const std::optional<directory> table = image.find_directory(directory_kind::imports);
    if (!table) {
        return std::vector<import_module>{};
    }
    std::vector<import_module> modules;
    for (const u32 index : std::views::iota(u32{0}, max_import_modules)) {
        const u32 offset = index * narrow<u32>(sizeof(detail::raw_import_descriptor));
        const auto descriptor =
            LUCENT_TRY(detail::read_rva<detail::raw_import_descriptor>(image, table->rva + offset));
        if (is_terminator(descriptor)) {
            return modules;
        }
        modules.push_back(
            import_module{
                .name = LUCENT_TRY(image.string_at(descriptor.name)),
                .entries = LUCENT_TRY(entries_of(image, descriptor)),
            }
        );
    }
    return std::unexpected(detail::malformed);
}

}
