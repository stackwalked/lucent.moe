#include <lucent/probe/strings.hpp>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/probe/module_file.hpp>

#include "ranges.hpp"

namespace lucent::probe {

auto string_rvas(const module_file& module, std::string_view text) -> std::vector<u32> {
    std::string stored{text};
    stored.push_back('\0');
    const std::span<const std::byte> needle = std::as_bytes(std::span{stored});
    std::vector<u32> found;
    for (const pe::rva_range range : detail::data_sections(module)) {
        const std::optional<std::span<const std::byte>> bytes = module.bytes_at(range);
        if (!bytes) {
            continue;
        }
        usize offset = 0;
        while (offset < bytes->size()) {
            const auto hit = std::ranges::search(bytes->subspan(offset), needle);
            if (hit.empty()) {
                break;
            }
            const auto position = narrow<usize>(hit.begin() - bytes->begin());
            found.push_back(range.rva + narrow<u32>(position));
            offset = position + 1;
        }
    }
    return found;
}

}
