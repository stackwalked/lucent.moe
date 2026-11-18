#include <lucent/probe/module_file.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <iterator>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>

namespace lucent::probe {

auto module_file::load(std::span<const std::byte> file) -> result<module_file> {
    const pe::image_view stored = LUCENT_TRY(pe::image_view::parse(file, pe::layout::file));
    std::vector<std::byte> mapped = LUCENT_TRY(pe::to_mapped_layout(stored));
    pe::image_view view = LUCENT_TRY(pe::image_view::parse(mapped, pe::layout::mapped));
    std::vector<pe::runtime_function> functions = LUCENT_TRY(pe::runtime_functions_of(view));
    return module_file{std::move(mapped), std::move(view), std::move(functions)};
}

module_file::module_file(
    std::vector<std::byte> mapped, pe::image_view view, std::vector<pe::runtime_function> functions
)
    : m_mapped{std::move(mapped)}
    , m_view{std::move(view)}
    , m_functions{std::move(functions)} {}

auto module_file::view() const -> const pe::image_view& {
    return m_view;
}

auto module_file::functions() const -> std::span<const pe::runtime_function> {
    return m_functions;
}

auto module_file::bytes_at(pe::rva_range range) const -> std::optional<std::span<const std::byte>> {
    const result<std::span<const std::byte>> bytes = m_view.bytes_at(range);
    if (!bytes) {
        return std::nullopt;
    }
    return *bytes;
}

auto module_file::u64_at(u32 rva) const -> std::optional<u64> {
    const std::optional<std::span<const std::byte>> bytes =
        bytes_at({.rva = rva, .size = sizeof(u64)});
    if (!bytes) {
        return std::nullopt;
    }
    std::array<std::byte, sizeof(u64)> raw{};
    std::ranges::copy(*bytes, raw.begin());
    return std::bit_cast<u64>(raw);
}

auto module_file::rva_of(u64 address) const -> std::optional<u32> {
    const u64 base = m_view.image_base();
    if (address < base || address - base >= m_view.size_of_image()) {
        return std::nullopt;
    }
    return static_cast<u32>(address - base);
}

auto module_file::is_code(u32 rva) const -> bool {
    return std::ranges::any_of(m_view.sections(), [&](const pe::section& stored) {
        return stored.access.is_executable
               && rva >= stored.virtual_address
               && rva - stored.virtual_address < pe::mapped_size_of(stored);
    });
}

auto module_file::function_containing(u32 rva) const -> std::optional<pe::runtime_function> {
    const auto after = std::ranges::upper_bound(m_functions, rva, {}, &pe::runtime_function::begin);
    if (after == m_functions.begin()) {
        return std::nullopt;
    }
    const pe::runtime_function& candidate = *std::ranges::prev(after);
    if (rva >= candidate.end) {
        return std::nullopt;
    }
    return candidate;
}

}
