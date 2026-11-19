#pragma once

#include <utility>

namespace lucent::refract {

// An operand's width in bytes.
enum class width : u8 { byte = 1, word = 2, dword = 4, qword = 8 };

constexpr auto bits_of(width size) -> u32 {
    return u32{std::to_underlying(size)} * 8;
}

// The bits a value of this width occupies, from bit 0.
constexpr auto mask_of(width size) -> u64 {
    return size == width::qword ? ~u64{0} : (u64{1} << bits_of(size)) - 1;
}

constexpr auto sign_bit_of(width size) -> u64 {
    return u64{1} << (bits_of(size) - 1);
}

static_assert(mask_of(width::byte) == 0xff);
static_assert(mask_of(width::qword) == 0xffff'ffff'ffff'ffff);
static_assert(sign_bit_of(width::word) == 0x8000);

}
