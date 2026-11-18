#pragma once

#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe::detail {

// The module's sections by what they hold, as RVA ranges in section order.
auto code_sections(const module_file& module) -> std::vector<pe::rva_range>;
auto data_sections(const module_file& module) -> std::vector<pe::rva_range>;

}
