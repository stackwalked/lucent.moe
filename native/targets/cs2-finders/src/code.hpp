#pragma once

#include <span>
#include <vector>

#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::finders {

// What one capture of the pattern read wherever it matches inside the functions.
auto captured_in(
    const probe::module_file& module,
    std::span<const pe::runtime_function> functions,
    const probe::instruction_pattern& pattern,
    isize capture
) -> std::vector<u64>;

// The functions holding the code at those addresses; an address without unwind data is skipped.
auto functions_at(const probe::module_file& module, std::span<const u32> addresses)
    -> std::vector<pe::runtime_function>;

}
