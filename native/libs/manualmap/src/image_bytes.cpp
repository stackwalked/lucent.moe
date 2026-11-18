#include "image_bytes.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>

namespace lucent::manualmap::detail {
namespace {

auto fits(usize image_size, u32 offset) -> bool {
    return offset <= image_size && sizeof(u64) <= image_size - offset;
}

}

auto read_u64(std::span<const std::byte> image, u32 offset) -> result<u64> {
    if (!fits(image.size(), offset)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::array<std::byte, sizeof(u64)> raw{};
    std::ranges::copy(image.subspan(offset, sizeof(u64)), raw.begin());
    return std::bit_cast<u64>(raw);
}

auto write_u64(std::span<std::byte> image, u32 offset, u64 value) -> result<void> {
    if (!fits(image.size(), offset)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::ranges::copy(
        std::bit_cast<std::array<std::byte, sizeof(u64)>>(value), image.subspan(offset).begin()
    );
    return {};
}

}
