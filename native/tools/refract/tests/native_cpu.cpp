#include "native_cpu.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <ranges>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <Zydis/Encoder.h>
#include <Zydis/Mnemonic.h>
#include <Zydis/Register.h>

#include <lucent/core/narrow.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/width.hpp>

#include "assembler.hpp"

namespace lucent::refract {
namespace {

// The code page's layout. The instruction sits close enough to the taken label for a rel8 branch.
constexpr isize prologue_offset = 0x000;
constexpr isize instruction_offset = 0x400;
constexpr isize instruction_room = 0x40;
constexpr isize taken_offset = instruction_offset + instruction_room;
constexpr isize fall_through_epilogue_offset = 0x600;
constexpr isize taken_epilogue_offset = 0x700;
constexpr isize registers_offset = 0xf00;
constexpr isize flags_offset = registers_offset + (gpr_count * 8);
constexpr isize saved_stack_offset = flags_offset + 8;
constexpr isize path_offset = saved_stack_offset + 8;
constexpr isize code_size = 0x1000;
constexpr isize memory_offset = code_size;

// Which way control left the instruction, as the epilogue records it.
enum class path : u8 { fell_through, taken };

// Bit 1 of RFLAGS always reads 1 and IF is set in user mode (Intel SDM vol. 1, 3.4.3); the
// direction flag stays clear, as the Windows x64 ABI requires at every call.
constexpr u64 fixed_flags = 0x202;

constexpr std::array<gpr, 8> callee_saved{
    gpr::rbx,
    gpr::rbp,
    gpr::rdi,
    gpr::rsi,
    gpr::r12,
    gpr::r13,
    gpr::r14,
    gpr::r15,
};

auto all_registers() -> std::array<gpr, gpr_count> {
    std::array<gpr, gpr_count> registers{};
    for (const auto [index, reg] : std::views::enumerate(registers)) {
        reg = gpr{narrow<u8>(index)};
    }
    return registers;
}

auto qword_register(gpr reg) -> ZydisEncoderOperand {
    return register_operand(zydis_register(reg, width::qword));
}

// Code for one stretch of the page, encoded where it will run.
class code_builder final {
public:
    explicit code_builder(u64 address)
        : m_address{address} {}

    auto add(const encoding& request) -> void {
        const std::vector<std::byte> bytes =
            encode(request, m_address + narrow<u64>(m_bytes.size()));
        m_bytes.insert(m_bytes.end(), bytes.begin(), bytes.end());
    }

    auto to_bytes() const -> std::vector<std::byte> {
        return m_bytes;
    }

private:
    u64 m_address = 0;
    std::vector<std::byte> m_bytes;
};

auto slot(u64 address, width size) -> ZydisEncoderOperand {
    return memory_operand(
        {.base = ZYDIS_REGISTER_RIP, .displacement = std::bit_cast<i64>(address), .size = size}
    );
}

auto register_slot(u64 page, gpr reg) -> ZydisEncoderOperand {
    return slot(
        page + narrow<u64>(registers_offset + (isize{std::to_underlying(reg)} * 8)), width::qword
    );
}

auto offset_slot(u64 page, isize offset, width size) -> ZydisEncoderOperand {
    return slot(page + narrow<u64>(offset), size);
}

auto jump_to(u64 target) -> encoding {
    return {.mnemonic = ZYDIS_MNEMONIC_JMP, .operands = {immediate_operand(target)}};
}

// Saves what the ABI says a callee keeps, then loads the machine's flags and registers. rsp goes
// last: until then the pushes above still have the real stack.
auto prologue_code(u64 page) -> std::vector<std::byte> {
    code_builder code{page + narrow<u64>(prologue_offset)};
    for (const gpr reg : callee_saved) {
        code.add({.mnemonic = ZYDIS_MNEMONIC_PUSH, .operands = {qword_register(reg)}});
    }
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_MOV,
        .operands = {offset_slot(page, saved_stack_offset, width::qword), qword_register(gpr::rsp)},
    });
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_PUSH,
        .operands = {offset_slot(page, flags_offset, width::qword)},
    });
    code.add({.mnemonic = ZYDIS_MNEMONIC_POPFQ, .operands = {}});
    for (const gpr reg : all_registers()) {
        if (reg != gpr::rsp) {
            code.add({
                .mnemonic = ZYDIS_MNEMONIC_MOV,
                .operands = {qword_register(reg), register_slot(page, reg)},
            });
        }
    }
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_MOV,
        .operands = {qword_register(gpr::rsp), register_slot(page, gpr::rsp)},
    });
    code.add(jump_to(page + narrow<u64>(instruction_offset)));
    return code.to_bytes();
}

// Records the path taken and stores the registers and flags back. Every store before pushfq is a
// mov, which leaves the flags as the instruction left them.
auto epilogue_code(u64 page, isize offset, path taken) -> std::vector<std::byte> {
    code_builder code{page + narrow<u64>(offset)};
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_MOV,
        .operands = {
            offset_slot(page, path_offset, width::byte),
            immediate_operand(std::to_underlying(taken)),
        },
    });
    for (const gpr reg : all_registers()) {
        code.add({
            .mnemonic = ZYDIS_MNEMONIC_MOV,
            .operands = {register_slot(page, reg), qword_register(reg)},
        });
    }
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_MOV,
        .operands = {qword_register(gpr::rsp), offset_slot(page, saved_stack_offset, width::qword)},
    });
    code.add({.mnemonic = ZYDIS_MNEMONIC_PUSHFQ, .operands = {}});
    code.add({
        .mnemonic = ZYDIS_MNEMONIC_POP,
        .operands = {offset_slot(page, flags_offset, width::qword)},
    });
    for (const gpr reg : callee_saved | std::views::reverse) {
        code.add({.mnemonic = ZYDIS_MNEMONIC_POP, .operands = {qword_register(reg)}});
    }
    code.add({.mnemonic = ZYDIS_MNEMONIC_RET, .operands = {}});
    return code.to_bytes();
}

}

auto native_cpu::page_release::operator()(std::byte* pages) const -> void {
    VirtualFree(pages, 0, MEM_RELEASE);
}

native_cpu::native_cpu()
    : m_pages{static_cast<std::byte*>(VirtualAlloc(
          nullptr,
          narrow<usize>(code_size + memory_size),
          MEM_COMMIT | MEM_RESERVE,
          PAGE_EXECUTE_READWRITE
      ))} {
    LUCENT_INVARIANT(m_pages != nullptr);
    const u64 page = address_at(0);
    std::ranges::fill(at(0).first(code_size), std::byte{0xcc});
    std::ranges::copy(prologue_code(page), at(prologue_offset).begin());
    code_builder taken{taken_address()};
    taken.add(jump_to(address_at(taken_epilogue_offset)));
    std::ranges::copy(taken.to_bytes(), at(taken_offset).begin());
    std::ranges::copy(
        epilogue_code(page, fall_through_epilogue_offset, path::fell_through),
        at(fall_through_epilogue_offset).begin()
    );
    std::ranges::copy(
        epilogue_code(page, taken_epilogue_offset, path::taken), at(taken_epilogue_offset).begin()
    );
}

auto native_cpu::instruction_address() const -> u64 {
    return address_at(instruction_offset);
}

auto native_cpu::taken_address() const -> u64 {
    return address_at(taken_offset);
}

auto native_cpu::memory_base() const -> u64 {
    return address_at(memory_offset);
}

auto native_cpu::run(std::span<const std::byte> code, machine& state) -> u64 {
    LUCENT_INVARIANT(state.memory.base == memory_base());
    LUCENT_INVARIANT(std::ssize(state.memory.bytes) == memory_size);

    code_builder exit{instruction_address() + code.size()};
    exit.add(jump_to(address_at(fall_through_epilogue_offset)));
    const std::vector<std::byte> exit_code = exit.to_bytes();
    LUCENT_INVARIANT(std::ssize(code) + std::ssize(exit_code) <= instruction_room);
    const std::span<std::byte> room = at(instruction_offset).first(instruction_room);
    std::ranges::fill(room, std::byte{0xcc});
    std::ranges::copy(exit_code, std::ranges::copy(code, room.begin()).out);

    const u64 flags = (state.flags & arithmetic_flags) | fixed_flags;
    std::ranges::copy(std::as_bytes(std::span{state.registers}), at(registers_offset).begin());
    std::ranges::copy(std::bit_cast<std::array<std::byte, 8>>(flags), at(flags_offset).begin());
    std::ranges::copy(std::as_bytes(std::span{state.memory.bytes}), at(memory_offset).begin());
    LUCENT_INVARIANT(
        FlushInstructionCache(GetCurrentProcess(), at(0).data(), narrow<usize>(code_size)) != 0
    );

    std::bit_cast<void (*)()>(address_at(prologue_offset))();

    const std::span<std::byte> registers = std::as_writable_bytes(std::span{state.registers});
    std::ranges::copy(at(registers_offset).first(registers.size()), registers.begin());
    std::array<std::byte, 8> after{};
    std::ranges::copy(at(flags_offset).first(after.size()), after.begin());
    state.flags =
        (state.flags & ~arithmetic_flags) | (std::bit_cast<u64>(after) & arithmetic_flags);
    const std::span<std::byte> memory = std::as_writable_bytes(std::span{state.memory.bytes});
    std::ranges::copy(at(memory_offset).first(memory.size()), memory.begin());
    const path taken{std::to_integer<u8>(at(path_offset).front())};
    return taken == path::taken ? taken_address() : instruction_address() + code.size();
}

auto native_cpu::at(isize offset) const -> std::span<std::byte> {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // VirtualAlloc'd that size
    const std::span<std::byte> pages{m_pages.get(), narrow<usize>(code_size + memory_size)};
#pragma clang diagnostic pop
    return pages.subspan(narrow<usize>(offset));
}

auto native_cpu::address_at(isize offset) const -> u64 {
    return std::bit_cast<u64>(at(offset).data());
}

}
