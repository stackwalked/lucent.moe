#include <lucent/probe/navigation.hpp>

#include <algorithm>
#include <optional>
#include <ranges>
#include <vector>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {
namespace {

// The longest x64 instruction.
constexpr u32 max_instruction_size = 15;
// Far above any real class's virtual function count; ends a walk off a vtable that's followed by
// more pointers into code.
constexpr u32 max_vtable_slots = 4096;

}

auto reference_at(const module_file& module, u32 rva) -> std::optional<reference> {
    const u32 size_of_image = module.view().size_of_image();
    if (rva >= size_of_image) {
        return std::nullopt;
    }
    const u32 size = std::min(max_instruction_size, size_of_image - rva);
    for (const reference& found : references_in(module, {.rva = rva, .size = size})) {
        if (found.source == rva) {
            return found;
        }
    }
    return std::nullopt;
}

auto vtable_functions(const module_file& module, u32 vtable) -> std::vector<u32> {
    std::vector<u32> functions;
    for (const u32 slot : std::views::iota(u32{0}, max_vtable_slots)) {
        const std::optional<u64> address = module.u64_at(vtable + (slot * u32{sizeof(u64)}));
        const std::optional<u32> function = address ? module.rva_of(*address) : std::nullopt;
        if (!function || !module.is_code(*function)) {
            break;
        }
        functions.push_back(*function);
    }
    return functions;
}

}
