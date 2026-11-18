#include <lucent/pe/exports.hpp>

#include <charconv>
#include <cstddef>
#include <expected>
#include <flat_map>
#include <functional>
#include <memory>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>

#include "format.hpp"

namespace lucent::pe {
namespace {

constexpr error not_found{.code = error_code::not_found};

// Above any real module (ntdll has a few thousand), and small enough that a corrupt count can't
// make us allocate much before the bounds check on the table catches it.
constexpr u32 max_exports = 65'536;

// "MODULE.Name" or "MODULE.#Ordinal". Module names may contain dots; the last one separates.
auto forwarder_from(std::string_view text) -> result<forwarder> {
    const usize dot = text.rfind('.');
    if (dot == std::string_view::npos || dot == 0 || dot + 1 == text.size()) {
        return std::unexpected(detail::malformed);
    }
    const std::string_view module = text.substr(0, dot);
    const std::string_view target = text.substr(dot + 1);
    if (!target.starts_with('#')) {
        return forwarder{.module = std::string{module}, .target = std::string{target}};
    }
    const std::string_view digits = target.substr(1);
    u16 ordinal = 0;
    const auto [end, failure] =
        std::from_chars(std::to_address(digits.begin()), std::to_address(digits.end()), ordinal);
    if (failure != std::errc{} || end != std::to_address(digits.end())) {
        return std::unexpected(detail::malformed);
    }
    return forwarder{.module = std::string{module}, .target = export_ordinal{ordinal}};
}

// An exported address inside the export directory is a forwarder string, not code.
auto target_at(const image_view& image, directory location, u32 rva)
    -> result<std::optional<export_target>> {
    if (rva == 0) {
        return std::nullopt;
    }
    const bool is_forwarder = rva >= location.rva && u64{rva} < u64{location.rva} + location.size;
    if (!is_forwarder) {
        return export_address{.rva = rva};
    }
    const std::string text = LUCENT_TRY(image.string_at(rva));
    return LUCENT_TRY(forwarder_from(text));
}

auto read_targets(
    const image_view& image, directory location, const detail::raw_export_directory& raw
) -> result<std::vector<std::optional<export_target>>> {
    const u32 size = raw.function_count * narrow<u32>(sizeof(u32));
    const std::span<const std::byte> functions =
        LUCENT_TRY(image.bytes_at({.rva = raw.functions, .size = size}));
    std::vector<std::optional<export_target>> targets;
    targets.reserve(raw.function_count);
    for (const u32 index : std::views::iota(u32{0}, raw.function_count)) {
        const u32 rva = LUCENT_TRY(detail::read_at<u32>(functions, usize{index} * sizeof(u32)));
        targets.push_back(LUCENT_TRY(target_at(image, location, rva)));
    }
    return targets;
}

auto read_names(const image_view& image, const detail::raw_export_directory& raw)
    -> result<std::flat_map<std::string, u32, std::less<>>> {
    const u32 names_size = raw.name_count * narrow<u32>(sizeof(u32));
    const u32 indices_size = raw.name_count * narrow<u32>(sizeof(u16));
    const std::span<const std::byte> names =
        LUCENT_TRY(image.bytes_at({.rva = raw.names, .size = names_size}));
    const std::span<const std::byte> indices =
        LUCENT_TRY(image.bytes_at({.rva = raw.name_ordinals, .size = indices_size}));
    std::flat_map<std::string, u32, std::less<>> index_of_name;
    for (const u32 index : std::views::iota(u32{0}, raw.name_count)) {
        const u32 name_rva = LUCENT_TRY(detail::read_at<u32>(names, usize{index} * sizeof(u32)));
        const u16 function_index =
            LUCENT_TRY(detail::read_at<u16>(indices, usize{index} * sizeof(u16)));
        if (function_index >= raw.function_count) {
            return std::unexpected(detail::malformed);
        }
        index_of_name.insert_or_assign(LUCENT_TRY(image.string_at(name_rva)), function_index);
    }
    return index_of_name;
}

}

auto export_table::from_image(const image_view& image) -> result<export_table> {
    export_table table;
    const std::optional<directory> location = image.find_directory(directory_kind::exports);
    if (!location) {
        return table;
    }
    const auto raw =
        LUCENT_TRY(detail::read_rva<detail::raw_export_directory>(image, location->rva));
    // Ordinals are 16 bits: every one the table defines must fit.
    const bool is_bounded = raw.function_count <= max_exports
                            && raw.name_count <= max_exports
                            && u64{raw.ordinal_base} + raw.function_count <= max_exports;
    if (!is_bounded) {
        return std::unexpected(detail::malformed);
    }
    table.m_ordinal_base = raw.ordinal_base;
    table.m_targets = LUCENT_TRY(read_targets(image, *location, raw));
    table.m_index_of_name = LUCENT_TRY(read_names(image, raw));
    return table;
}

auto export_table::find(std::string_view name) const -> result<export_target> {
    return find(LUCENT_TRY(ordinal_of(name)));
}

auto export_table::find(export_ordinal ordinal) const -> result<export_target> {
    const u32 value = std::to_underlying(ordinal);
    if (value < m_ordinal_base || value - m_ordinal_base >= m_targets.size()) {
        return std::unexpected(not_found);
    }
    const std::optional<export_target>& target = m_targets.at(value - m_ordinal_base);
    if (!target) {
        return std::unexpected(not_found);
    }
    return *target;
}

auto export_table::ordinal_of(std::string_view name) const -> result<export_ordinal> {
    const auto found = m_index_of_name.find(name);
    if (found == m_index_of_name.end()) {
        return std::unexpected(not_found);
    }
    // from_image bounded the base plus every index to 16 bits.
    return export_ordinal{narrow<u16>(m_ordinal_base + found->second)};
}

}
