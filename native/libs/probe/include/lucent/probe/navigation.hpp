#pragma once

#include <optional>
#include <vector>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// The reference the instruction at rva makes: a branch's destination, or the place a RIP-relative
// operand names (for a call through memory, the slot it reads). Absent when it makes none.
auto reference_at(const module_file& module, u32 rva) -> std::optional<reference>;

// The functions a vtable lists, in slot order: its slots up to the first that doesn't point into
// code.
auto vtable_functions(const module_file& module, u32 vtable) -> std::vector<u32>;

}
