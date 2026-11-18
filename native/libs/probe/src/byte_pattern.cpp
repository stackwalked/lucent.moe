#include <lucent/probe/byte_pattern.hpp>

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

#include "ranges.hpp"

namespace lucent::probe {

auto pattern_rvas(const module_file& module, const byte_pattern& pattern) -> std::vector<u32> {
    std::vector<u32> found;
    for (const pe::rva_range range : detail::code_sections(module)) {
        const std::optional<std::span<const std::byte>> code = module.bytes_at(range);
        if (!code) {
            continue;
        }
        for (usize offset = 0; offset < code->size(); ++offset) {
            if (pattern.matches(code->subspan(offset))) {
                found.push_back(range.rva + narrow<u32>(offset));
            }
        }
    }
    return found;
}

}
