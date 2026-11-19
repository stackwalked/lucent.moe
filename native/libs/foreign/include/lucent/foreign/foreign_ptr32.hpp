#pragma once

#include <lucent/foreign/foreign_ptr.hpp>

namespace lucent::foreign {

// A T in a 32-bit target's memory, laid out as that target lays out its pointers. The x64 host
// reads 32-bit targets (osu! stable) through these.
template <addressable T>
struct foreign_ptr32 {
    u32 address = 0;

    auto operator==(const foreign_ptr32&) const -> bool = default;
};

static_assert(sizeof(foreign_ptr32<std::byte>) == 4, "a 32-bit target's pointer");

template <addressable T>
constexpr auto is_null(foreign_ptr32<T> pointer) -> bool {
    return pointer.address == 0;
}

}
