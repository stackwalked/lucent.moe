#pragma once

#include <optional>
#include <string_view>
#include <vector>

#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::finder {

// The first part of the function a part belongs to, following the parts' unwind chain
// (UNW_FLAG_CHAININFO): the compiler splits a function into parts with .pdata entries of their
// own, and only the first is where it starts.
auto function_start(const probe::module_file& module, const pe::runtime_function& part) -> u32;

// The parts of the function starting at start: its first, and the parts after it chained to it.
auto parts_of(const probe::module_file& module, u32 start) -> std::vector<pe::runtime_function>;

// The complete-object vtable MSVC's RTTI ties to the class; empty without one.
auto primary_vtable(const probe::module_file& module, std::string_view name) -> std::optional<u32>;

// The functions the class's complete-object vtable lists, in slot order, as their entry RVAs.
auto slots_of(const probe::module_file& module, std::string_view name) -> std::vector<u32>;

// Every part of the class's slot functions.
auto slot_functions(const probe::module_file& module, std::string_view name)
    -> std::vector<pe::runtime_function>;

// The index of the function at `entry` in the class's vtable: none when it isn't there, ambiguous
// when it is there twice.
auto slot_index(const probe::module_file& module, std::string_view name, u32 entry)
    -> probe::finding;

// Every part of the functions those call or jump to at their start, each once.
auto callees_of(const probe::module_file& module, std::span<const pe::runtime_function> callers)
    -> std::vector<pe::runtime_function>;

// One capture of the pattern wherever it matches in the class's slot functions.
auto captured_in_class(
    const probe::module_file& module,
    std::string_view name,
    const probe::instruction_pattern& pattern,
    isize capture
) -> probe::finding;

}
