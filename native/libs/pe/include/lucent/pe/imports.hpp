#pragma once

#include <string>
#include <variant>
#include <vector>

#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

struct import_by_name {
    std::string name;
    // Where the exporter's name table probably has it; a lookup may start there.
    u16 hint = 0;

    auto operator==(const import_by_name&) const -> bool = default;
};

using import_target = std::variant<import_by_name, export_ordinal>;

struct import_entry {
    import_target target;
    // The address-table slot a loader writes the resolved address into.
    u32 slot_rva = 0;
};

struct import_module {
    std::string name;
    std::vector<import_entry> entries;
};

auto imports_of(const image_view& image) -> result<std::vector<import_module>>;

}
