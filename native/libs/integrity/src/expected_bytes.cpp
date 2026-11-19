#include <lucent/integrity/expected_bytes.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <ranges>
#include <span>
#include <vector>

#include <lucent/pe/image_view.hpp>
#include <lucent/pe/relocations.hpp>

namespace lucent::integrity {
namespace {

constexpr error malformed{.code = error_code::malformed};

auto overlaps(u32 slot, pe::rva_range range) -> bool {
    const u64 slot_end = u64{slot} + sizeof(u64);
    const u64 range_end = u64{range.rva} + range.size;
    return u64{slot} < range_end && slot_end > range.rva;
}

auto slot_in(std::span<std::byte> image, u32 slot) -> result<std::span<std::byte>> {
    if (slot > image.size() || image.size() - slot < sizeof(u64)) {
        return std::unexpected(malformed);
    }
    return image.subspan(slot, sizeof(u64));
}

auto move_by(std::span<std::byte> target, u64 delta) -> void {
    std::array<std::byte, sizeof(u64)> raw{};
    std::ranges::copy(target, raw.begin());
    // Unsigned wraparound is the relocation: a base below the preferred one is a negative delta.
    const u64 moved = std::bit_cast<u64>(raw) + delta;
    std::ranges::copy(std::bit_cast<std::array<std::byte, sizeof(u64)>>(moved), target.begin());
}

}

auto expected_bytes(const pe::image_view& file, u64 base, pe::rva_range range)
    -> result<std::vector<std::byte>> {
    std::vector<std::byte> mapped = LUCENT_TRY(pe::to_mapped_layout(file));
    if (range.rva > mapped.size() || mapped.size() - range.rva < range.size) {
        return std::unexpected(malformed);
    }
    const u64 delta = base - file.image_base();
    for (const u32 slot : LUCENT_TRY(pe::relocations_of(file))) {
        if (overlaps(slot, range)) {
            move_by(LUCENT_TRY(slot_in(mapped, slot)), delta);
        }
    }
    return std::span<const std::byte>{mapped}.subspan(range.rva, range.size)
           | std::ranges::to<std::vector>();
}

}
