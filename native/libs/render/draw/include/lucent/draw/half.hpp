#pragma once

#include <bit>

#include <lucent/core/narrow.hpp>

namespace lucent::draw {

// IEEE-754 binary16, the form f16tof32 reads in a shader: records carry small lengths (softness,
// stroke width) as two of these in one u32. Rounds to nearest, ties to even; overflow becomes
// infinity, which check() refuses.
constexpr auto to_half(f32 value) -> u16 {
    const u32 bits = std::bit_cast<u32>(value);
    const u32 sign = (bits >> 16U) & 0x8000U;
    const u32 exponent = (bits >> 23U) & 0xffU;
    const u32 mantissa = bits & 0x7f'ffffU;
    if (exponent == 0xffU) {
        return narrow<u16>(sign | 0x7c00U | (mantissa != 0 ? 0x200U : 0U));
    }
    const i32 half_exponent = static_cast<i32>(exponent) - 127 + 15;
    if (half_exponent >= 0x1f) {
        return narrow<u16>(sign | 0x7c00U);
    }
    if (half_exponent <= 0) {
        // Subnormal: the implicit bit joins the mantissa, shifted to the half's fixed exponent.
        if (half_exponent < -10) {
            return narrow<u16>(sign);
        }
        const u32 full = mantissa | 0x80'0000U;
        const u32 shift = static_cast<u32>(14 - half_exponent);
        const u32 kept = full >> shift;
        const u32 rest = full & ((1U << shift) - 1U);
        const u32 halfway = 1U << (shift - 1U);
        const bool should_round_up = rest > halfway || (rest == halfway && (kept & 1U) != 0);
        return narrow<u16>(sign | (kept + (should_round_up ? 1U : 0U)));
    }
    const u32 kept = (static_cast<u32>(half_exponent) << 10U) | (mantissa >> 13U);
    const u32 rest = mantissa & 0x1fffU;
    const bool should_round_up = rest > 0x1000U || (rest == 0x1000U && (kept & 1U) != 0);
    // A carry out of the mantissa raises the exponent, which is the correct rounding.
    return narrow<u16>(sign | (kept + (should_round_up ? 1U : 0U)));
}

constexpr auto is_finite_half(u16 bits) -> bool {
    return (bits & 0x7c00U) != 0x7c00U;
}

constexpr auto from_half(u16 bits) -> f32 {
    const u32 sign = (u32{bits} & 0x8000U) << 16U;
    const u32 exponent = (u32{bits} >> 10U) & 0x1fU;
    const u32 mantissa = u32{bits} & 0x3ffU;
    if (exponent == 0x1fU) {
        return std::bit_cast<f32>(sign | 0x7f80'0000U | (mantissa << 13U));
    }
    if (exponent != 0) {
        return std::bit_cast<f32>(sign | ((exponent + 112U) << 23U) | (mantissa << 13U));
    }
    if (mantissa == 0) {
        return std::bit_cast<f32>(sign);
    }
    // Subnormal: shift the leading one into the implicit bit and lower the exponent to match.
    const u32 shift = static_cast<u32>(std::countl_zero(mantissa)) - 21U;
    const u32 normal = (mantissa << shift) & 0x3ffU;
    return std::bit_cast<f32>(sign | ((113U - shift) << 23U) | (normal << 13U));
}

}
