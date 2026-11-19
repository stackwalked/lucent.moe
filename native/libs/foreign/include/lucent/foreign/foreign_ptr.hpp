#pragma once

#include <type_traits>

namespace lucent::foreign {

// What a foreign pointer may point at: any object type, complete or only declared (a mirror the
// code never reads whole).
template <typename T>
concept addressable = std::is_object_v<T>;

// A T in foreign memory, laid out as a 64-bit target lays out its pointers, so a mirror of a
// foreign structure holds one wherever the target holds a pointer. Never dereferenced: its T is
// read through a memory_source.
template <addressable T>
struct foreign_ptr {
    u64 address = 0;

    auto operator==(const foreign_ptr&) const -> bool = default;
};

static_assert(sizeof(foreign_ptr<std::byte>) == 8, "a 64-bit target's pointer");

template <addressable T>
constexpr auto is_null(foreign_ptr<T> pointer) -> bool {
    return pointer.address == 0;
}

// The index-th T of the foreign array that starts at first.
template <addressable T>
constexpr auto element(foreign_ptr<T> first, isize index) -> foreign_ptr<T> {
    LUCENT_INVARIANT(index >= 0);
    return foreign_ptr<T>{.address = first.address + (static_cast<u64>(index) * sizeof(T))};
}

}
