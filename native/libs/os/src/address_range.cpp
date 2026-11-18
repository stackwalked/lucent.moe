#include <lucent/os/address_range.hpp>

#include <bit>
#include <expected>

#include <Windows.h>

namespace lucent::os {
namespace {

auto query(uptr address) -> result<MEMORY_BASIC_INFORMATION> {
    MEMORY_BASIC_INFORMATION region{};
    if (VirtualQuery(std::bit_cast<const void*>(address), &region, sizeof(region)) == 0) {
        return std::unexpected(last_system_error());
    }
    return region;
}

}

auto contains(const address_range& range, uptr address) -> bool {
    return address >= range.begin && address < range.end;
}

auto allocation_containing(uptr address) -> result<address_range> {
    const MEMORY_BASIC_INFORMATION first = LUCENT_TRY(query(address));
    if (first.State == MEM_FREE) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    const auto base = std::bit_cast<uptr>(first.AllocationBase);
    uptr end = base;
    // An allocation is contiguous: walk its regions until one belongs to another allocation.
    while (true) {
        const MEMORY_BASIC_INFORMATION region = LUCENT_TRY(query(end));
        if (region.State == MEM_FREE || std::bit_cast<uptr>(region.AllocationBase) != base) {
            break;
        }
        end = std::bit_cast<uptr>(region.BaseAddress) + region.RegionSize;
    }
    return address_range{.begin = base, .end = end};
}

}
