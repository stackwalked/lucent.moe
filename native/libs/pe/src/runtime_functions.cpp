#include <lucent/pe/runtime_functions.hpp>

#include <cstddef>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <vector>

#include <lucent/pe/image_view.hpp>

#include "format.hpp"

namespace lucent::pe {
namespace {

auto is_ordered_after(const runtime_function& entry, const std::vector<runtime_function>& before)
    -> bool {
    return before.empty() || before.back().end <= entry.begin;
}

auto is_valid(const image_view& image, const runtime_function& entry) -> bool {
    return entry.begin < entry.end
           && entry.end <= image.size_of_image()
           && entry.unwind_info < image.size_of_image();
}

}

auto runtime_functions_of(const image_view& image) -> result<std::vector<runtime_function>> {
    std::vector<runtime_function> functions;
    const std::optional<directory> location = image.find_directory(directory_kind::exceptions);
    if (!location) {
        return functions;
    }
    constexpr usize entry_size = sizeof(detail::raw_runtime_function);
    if (location->size % entry_size != 0) {
        return std::unexpected(detail::malformed);
    }
    const std::span<const std::byte> table =
        LUCENT_TRY(image.bytes_at({.rva = location->rva, .size = location->size}));
    functions.reserve(table.size() / entry_size);
    for (const usize index : std::views::iota(usize{0}, table.size() / entry_size)) {
        const auto raw =
            LUCENT_TRY(detail::read_at<detail::raw_runtime_function>(table, index * entry_size));
        const runtime_function entry{
            .begin = raw.begin,
            .end = raw.end,
            .unwind_info = raw.unwind_info,
        };
        if (!is_valid(image, entry) || !is_ordered_after(entry, functions)) {
            return std::unexpected(detail::malformed);
        }
        functions.push_back(entry);
    }
    return functions;
}

}
