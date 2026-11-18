#pragma once

namespace lucent::draw {

// sRGB with straight alpha: what a caller writes is what they mean. The backend premultiplies and
// blends in the target's space.
struct color {
    u8 r = 0;
    u8 g = 0;
    u8 b = 0;
    u8 a = 0;

    auto operator==(const color&) const -> bool = default;
};

inline constexpr color white{.r = 255, .g = 255, .b = 255, .a = 255};
inline constexpr color transparent{};

// The four channels in one u32, red in the low byte: the order R8G8B8A8_UNORM reads them in, so a
// shader unpacks a record's colour without caring about host byte order.
constexpr auto packed(color value) -> u32 {
    return u32{value.r} | (u32{value.g} << 8U) | (u32{value.b} << 16U) | (u32{value.a} << 24U);
}

constexpr auto with_alpha(color value, u8 alpha) -> color {
    return {.r = value.r, .g = value.g, .b = value.b, .a = alpha};
}

}
