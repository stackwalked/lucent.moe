#pragma once

#include <array>
#include <utility>
#include <vector>

#include <lucent/refract/width.hpp>

namespace lucent::refract {

// The general-purpose registers in their x86-64 encoding order (Intel SDM vol. 2, 2.2.1.2), which
// is also how a machine's registers are indexed.
enum class gpr : u8 {
    rax,
    rcx,
    rdx,
    rbx,
    rsp,
    rbp,
    rsi,
    rdi,
    r8,
    r9,
    r10,
    r11,
    r12,
    r13,
    r14,
    r15,
};

constexpr isize gpr_count = 16;

// The RFLAGS bits the lifted subset reads or writes, named by their bit position (Intel SDM vol. 1,
// 3.4.3, "EFLAGS Register").
enum class flag : u8 { carry = 0, parity = 2, adjust = 4, zero = 6, sign = 7, overflow = 11 };

constexpr auto mask_of(flag bit) -> u64 {
    return u64{1} << std::to_underlying(bit);
}

constexpr u64 arithmetic_flags = mask_of(flag::carry)
                                 | mask_of(flag::parity)
                                 | mask_of(flag::adjust)
                                 | mask_of(flag::zero)
                                 | mask_of(flag::sign)
                                 | mask_of(flag::overflow);

// All the memory the interpreter may touch: one run of bytes at a fixed address. An access that
// leaves it is a fault, never a read of the host's own memory.
struct memory_region {
    u64 base = 0;
    std::vector<u8> bytes;

    auto operator==(const memory_region&) const -> bool = default;
};

struct memory_access {
    u64 address = 0;
    width size = width::qword;

    auto operator==(const memory_access&) const -> bool = default;
};

auto is_mapped(const memory_region& memory, memory_access access) -> bool;

// Little-endian, as x86 stores. The access must be mapped.
auto value_at(const memory_region& memory, memory_access access) -> u64;
auto write(memory_region& memory, memory_access access, u64 value) -> void;

// The state an x86-64 instruction from the lifted subset reads and writes. Flags is the RFLAGS
// image; only arithmetic_flags change.
struct machine {
    std::array<u64, gpr_count> registers{};
    u64 flags = 0;
    memory_region memory;

    auto operator==(const machine&) const -> bool = default;
};

}
