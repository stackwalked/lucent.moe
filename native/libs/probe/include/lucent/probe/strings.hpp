#pragma once

#include <string_view>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// Where the data sections store text followed by a NUL, in address order. A longer string ending in
// text matches too, at its tail, which code never points at.
auto string_rvas(const module_file& module, std::string_view text) -> std::vector<u32>;

// Where the data sections store a NUL-terminated string ending in tail, as the string's start,
// which is what code points at; each once, in address order. A build path's tail
// ("\\client\\view.cpp") finds it whichever machine built the module.
auto strings_ending_with(const module_file& module, std::string_view tail) -> std::vector<u32>;

}
