#pragma once

#include <string_view>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// Where the data sections store text followed by a NUL, in address order. A longer string ending in
// text matches too, at its tail, which code never points at.
auto string_rvas(const module_file& module, std::string_view text) -> std::vector<u32>;

}
