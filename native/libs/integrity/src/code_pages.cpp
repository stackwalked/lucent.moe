#include <lucent/integrity/code_pages.hpp>

#include <algorithm>
#include <bit>
#include <span>

#include <Windows.h>

#include <lucent/os/address_range.hpp>

namespace lucent::integrity {
namespace {

auto is_sealed(const MEMORY_BASIC_INFORMATION& region) -> bool {
    if (region.State != MEM_COMMIT || (region.Protect & PAGE_GUARD) != 0) {
        return false;
    }
    // The low byte is the access; the bits above it are modifiers (guard, no-cache).
    const DWORD access = region.Protect & 0xffU;
    return access == PAGE_EXECUTE || access == PAGE_EXECUTE_READ;
}

auto is_range_sealed(const os::address_range& range) -> bool {
    LUCENT_INVARIANT(range.begin <= range.end);
    uptr address = range.begin;
    // Each region ends past the address queried, so the walk advances every step.
    while (address < range.end) {
        MEMORY_BASIC_INFORMATION region{};
        if (VirtualQuery(std::bit_cast<const void*>(address), &region, sizeof(region)) == 0) {
            return false;
        }
        if (!is_sealed(region)) {
            return false;
        }
        address = std::bit_cast<uptr>(region.BaseAddress) + region.RegionSize;
    }
    return true;
}

}

auto is_code_sealed(std::span<const os::address_range> ranges) -> bool {
    return std::ranges::all_of(ranges, is_range_sealed);
}

}
