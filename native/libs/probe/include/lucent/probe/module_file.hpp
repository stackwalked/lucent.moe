#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/pe/runtime_functions.hpp>

namespace lucent::probe {

// A module read from disk and laid out the way a loader maps it, without relocating it: an RVA
// indexes it directly, and absolute addresses inside it are relative to its preferred base.
class module_file final {
public:
    static auto load(std::span<const std::byte> file) -> result<module_file>;

    module_file(const module_file&) = delete ("the view would point into the original's bytes");
    auto operator=(const module_file&) -> module_file& = delete ("the view points into its bytes");
    // Moving keeps the bytes' heap buffer, so the view stays valid.
    module_file(module_file&&) noexcept = default;
    auto operator=(module_file&&) -> module_file& = delete ("the view points into its bytes");
    ~module_file() = default;

    auto view() const -> const pe::image_view&;
    // Sorted by begin. Leaf functions that never touch the stack have no entry.
    auto functions() const -> std::span<const pe::runtime_function>;

    // Absent when the range isn't inside the image.
    auto bytes_at(pe::rva_range range) const -> std::optional<std::span<const std::byte>>;
    auto u64_at(u32 rva) const -> std::optional<u64>;
    // An absolute address as an RVA: absent when it doesn't point into the image.
    auto rva_of(u64 address) const -> std::optional<u32>;
    auto is_code(u32 rva) const -> bool;
    auto function_containing(u32 rva) const -> std::optional<pe::runtime_function>;

private:
    module_file(
        std::vector<std::byte> mapped,
        pe::image_view view,
        std::vector<pe::runtime_function> functions
    );

    std::vector<std::byte> m_mapped;
    pe::image_view m_view;
    std::vector<pe::runtime_function> m_functions;
};

}
