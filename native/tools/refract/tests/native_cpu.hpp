#pragma once

#include <cstddef>
#include <memory>
#include <span>

#include <lucent/refract/machine.hpp>

namespace lucent::refract {

// Runs one instruction on this CPU over a machine's state. A page of generated code loads every
// register, rsp included, and the arithmetic flags from the machine, runs the instruction, and
// stores them back; the machine's memory is a page beside it, so its addresses are real.
class native_cpu final {
public:
    static constexpr isize memory_size = 4096;

    native_cpu();

    // Where the instruction runs: rip-relative operands and branch targets are encoded from it.
    auto instruction_address() const -> u64;
    // Where a taken branch or a return should go: the run then reports it as the next address.
    auto taken_address() const -> u64;
    auto memory_base() const -> u64;

    // Runs code, encoded for instruction_address(), and gives the address control went to. The
    // state's memory must be the memory_size bytes at memory_base(), and every access the
    // instruction makes must land in it: a fault here takes the test process down.
    auto run(std::span<const std::byte> code, machine& state) -> u64;

private:
    struct page_release {
        auto operator()(std::byte* pages) const -> void;
    };

    std::unique_ptr<std::byte, page_release> m_pages;

    auto at(isize offset) const -> std::span<std::byte>;
    auto address_at(isize offset) const -> u64;
};

}
