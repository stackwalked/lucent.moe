#include <lucent/refract/machine.hpp>

#include <utility>

#include <lucent/core/narrow.hpp>

namespace lucent::refract {

auto is_mapped(const memory_region& memory, memory_access access) -> bool {
    const u64 length = std::to_underlying(access.size);
    return access.address >= memory.base
           && access.address - memory.base <= memory.bytes.size()
           && memory.bytes.size() - (access.address - memory.base) >= length;
}

auto value_at(const memory_region& memory, memory_access access) -> u64 {
    LUCENT_INVARIANT(is_mapped(memory, access));
    const auto offset = narrow<usize>(access.address - memory.base);
    u64 value = 0;
    for (usize i = std::to_underlying(access.size); i > 0; --i) {
        value = (value << 8U) | u64{memory.bytes.at(offset + i - 1)};
    }
    return value;
}

auto write(memory_region& memory, memory_access access, u64 value) -> void {
    LUCENT_INVARIANT(is_mapped(memory, access));
    const auto offset = narrow<usize>(access.address - memory.base);
    u64 rest = value;
    for (usize i = 0; i < std::to_underlying(access.size); ++i) {
        memory.bytes.at(offset + i) = narrow<u8>(rest & 0xffU);
        rest >>= 8U;
    }
}

}
