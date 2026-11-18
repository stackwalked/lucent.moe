#include "ranges.hpp"

#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe::detail {
namespace {

auto range_of(const pe::section& stored) -> pe::rva_range {
    return {.rva = stored.virtual_address, .size = pe::mapped_size_of(stored)};
}

}

auto code_sections(const module_file& module) -> std::vector<pe::rva_range> {
    std::vector<pe::rva_range> ranges;
    for (const pe::section& stored : module.view().sections()) {
        if (stored.access.is_executable) {
            ranges.push_back(range_of(stored));
        }
    }
    return ranges;
}

auto data_sections(const module_file& module) -> std::vector<pe::rva_range> {
    std::vector<pe::rva_range> ranges;
    for (const pe::section& stored : module.view().sections()) {
        if (stored.access.is_readable && !stored.access.is_executable) {
            ranges.push_back(range_of(stored));
        }
    }
    return ranges;
}

}
