#pragma once

#include <optional>
#include <vector>

#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// The reference the instruction at rva makes: a branch's destination, or the place a RIP-relative
// operand names (for a call through memory, the slot it reads). Absent when it makes none.
auto reference_at(const module_file& module, u32 rva) -> std::optional<reference>;

// The functions a vtable lists, in slot order: its slots up to the first that doesn't point into
// code.
auto vtable_functions(const module_file& module, u32 vtable) -> std::vector<u32>;

// The .pdata functions whose code makes a reference to target, each once, in address order. A
// reference from code without unwind data (a leaf, a thunk) has no function and is left out.
auto functions_referencing(const module_file& module, const code_index& index, u32 target)
    -> std::vector<pe::runtime_function>;

// The .pdata functions that call the function at `function` directly, as functions_referencing.
auto callers_of(const module_file& module, const code_index& index, u32 function)
    -> std::vector<pe::runtime_function>;

}
