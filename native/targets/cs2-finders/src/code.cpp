#include "code.hpp"

#include <optional>
#include <span>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/probe/instruction_pattern.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::finders {

auto captured_in(
    const probe::module_file& module,
    std::span<const pe::runtime_function> functions,
    const probe::instruction_pattern& pattern,
    isize capture
) -> std::vector<u64> {
    std::vector<u64> values;
    for (const pe::runtime_function& function : functions) {
        const pe::rva_range code{.rva = function.begin, .size = function.end - function.begin};
        values.append_range(probe::captured(probe::matches_in(module, code, pattern), capture));
    }
    return values;
}

auto functions_at(const probe::module_file& module, std::span<const u32> addresses)
    -> std::vector<pe::runtime_function> {
    std::vector<pe::runtime_function> functions;
    for (const u32 address : addresses) {
        if (const std::optional<pe::runtime_function> holder =
                module.function_containing(address)) {
            functions.push_back(*holder);
        }
    }
    return functions;
}

}
