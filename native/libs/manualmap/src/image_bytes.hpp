#pragma once

#include <cstddef>
#include <span>

namespace lucent::manualmap::detail {

// 64-bit values in the local copy of an image, by offset from its base.
auto read_u64(std::span<const std::byte> image, u32 offset) -> result<u64>;
auto write_u64(std::span<std::byte> image, u32 offset, u64 value) -> result<void>;

}
