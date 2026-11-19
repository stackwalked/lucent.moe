#include "time_date_stamp.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>

#include <lucent/pe/image_view.hpp>

namespace lucent::kit::detail {
namespace {

// build: PE/COFF specification (Microsoft, "PE Format"): e_lfanew, the u32 at 0x3c of the DOS
// header, is the offset of the "PE\0\0" signature; the COFF header follows it, with Machine (u16)
// and NumberOfSections (u16) before TimeDateStamp (u32).
// found: the spec; checked by tests/fact_apply_test.cpp against the loaded test image and its file
// breaks: every module key mismatches, so no fact set applies
constexpr usize new_header_offset_at = 0x3c;
constexpr usize time_date_stamp_in_new_header = 8;

auto u32_at(std::span<const std::byte> bytes, usize offset) -> result<u32> {
    if (offset > bytes.size() || bytes.size() - offset < sizeof(u32)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::array<std::byte, sizeof(u32)> little{};
    std::ranges::copy(bytes.subspan(offset, sizeof(u32)), little.begin());
    // x64 is little-endian, as PE is.
    return std::bit_cast<u32>(little);
}

}

auto time_date_stamp_of(const pe::image_view& image) -> result<u32> {
    const std::span<const std::byte> headers = image.headers();
    const u32 new_header = LUCENT_TRY(u32_at(headers, new_header_offset_at));
    return u32_at(headers, usize{new_header} + time_date_stamp_in_new_header);
}

}
