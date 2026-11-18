#include <lucent/pe/tls.hpp>

#include <expected>
#include <optional>
#include <ranges>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>

#include "format.hpp"

namespace lucent::pe {
namespace {

// Far above what a linker emits.
constexpr u32 max_callbacks = 256;

auto rva_of(const image_view& image, u64 address) -> result<u32> {
    if (address < image.image_base() || address - image.image_base() >= image.size_of_image()) {
        return std::unexpected(detail::malformed);
    }
    return static_cast<u32>(address - image.image_base());
}

auto callbacks_of(const image_view& image, u64 list_address) -> result<std::vector<u32>> {
    std::vector<u32> callbacks;
    if (list_address == 0) {
        return callbacks;
    }
    const u32 list = LUCENT_TRY(rva_of(image, list_address));
    for (const u32 index : std::views::iota(u32{0}, max_callbacks)) {
        const u64 callback =
            LUCENT_TRY(detail::read_rva<u64>(image, list + (index * narrow<u32>(sizeof(u64)))));
        if (callback == 0) {
            return callbacks;
        }
        callbacks.push_back(LUCENT_TRY(rva_of(image, callback)));
    }
    return std::unexpected(detail::malformed);
}

}

auto tls_of(const image_view& image) -> result<std::optional<tls_info>> {
    const std::optional<directory> location = image.find_directory(directory_kind::tls);
    if (!location) {
        return std::nullopt;
    }
    const auto raw = LUCENT_TRY(detail::read_rva<detail::raw_tls_directory>(image, location->rva));
    if (raw.raw_data_end < raw.raw_data_start) {
        return std::unexpected(detail::malformed);
    }
    const u32 template_start =
        raw.raw_data_start == 0 ? 0 : LUCENT_TRY(rva_of(image, raw.raw_data_start));
    const u64 template_size = raw.raw_data_end - raw.raw_data_start;
    if (u64{template_start} + template_size > image.size_of_image()) {
        return std::unexpected(detail::malformed);
    }
    return tls_info{
        .template_data = {.rva = template_start, .size = static_cast<u32>(template_size)},
        .zero_fill_size = raw.zero_fill_size,
        .index_rva = LUCENT_TRY(rva_of(image, raw.index_address)),
        .callback_rvas = LUCENT_TRY(callbacks_of(image, raw.callbacks_address)),
    };
}

}
