#pragma once

#include <cstddef>
#include <cstdint>

#include <lucent/core/invariant.hpp>

namespace lucent {

using i8 = std::int8_t;
using i16 = std::int16_t;
using i32 = std::int32_t;
using i64 = std::int64_t;
using u8 = std::uint8_t;
using u16 = std::uint16_t;
using u32 = std::uint32_t;
using u64 = std::uint64_t;
using isize = std::ptrdiff_t;
using usize = std::size_t;
using uptr = std::uintptr_t;
using f32 = float;
using f64 = double;

static_assert(sizeof(f32) == 4, "f32 is IEEE-754 binary32, the width foreign layouts use");
static_assert(sizeof(f64) == 8, "f64 is IEEE-754 binary64");

}

// After the aliases, which they use.
#include <lucent/core/fault.hpp>
#include <lucent/core/result.hpp>
