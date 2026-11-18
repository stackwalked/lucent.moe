#pragma once

namespace lucent::os {

// [begin, end) in this process's address space.
struct address_range {
    uptr begin = 0;
    uptr end = 0;

    auto operator==(const address_range&) const -> bool = default;
};

auto contains(const address_range& range, uptr address) -> bool;

// The whole allocation `address` lies in: an image the loader or our mapper placed, or one
// VirtualAlloc reservation.
auto allocation_containing(uptr address) -> result<address_range>;

}
