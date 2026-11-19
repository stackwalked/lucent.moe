#include <lucent/refract/function.hpp>

#include <cstddef>
#include <expected>
#include <initializer_list>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/refract/execution.hpp>
#include <lucent/refract/machine.hpp>
#include <lucent/refract/refusal.hpp>
#include <lucent/refract/width.hpp>

namespace lucent::refract {
namespace {

constexpr u64 code_address = 0x1'4000'1000;
constexpr u64 memory_base = 0x1'0000;
constexpr u64 stack_top = memory_base + 0x80;
constexpr u64 return_address = 0x1'4000'2345;
constexpr isize step_limit = 1000;

auto bytes_of(std::initializer_list<u8> values) -> std::vector<std::byte> {
    std::vector<std::byte> bytes;
    for (const u8 value : values) {
        bytes.push_back(std::byte{value});
    }
    return bytes;
}

auto lifted_from(std::initializer_list<u8> code) -> function {
    std::expected<function, refusal> lifted = lift_function(bytes_of(code), code_address);
    REQUIRE(lifted.has_value());
    return std::move(lifted).value_or(function{});
}

auto refusal_of(std::initializer_list<u8> code) -> refusal {
    const std::expected<function, refusal> lifted = lift_function(bytes_of(code), code_address);
    REQUIRE(!lifted.has_value());
    return lifted.error();
}

// A machine as at a call: rsp on the return address.
auto called_with(gpr argument, u64 value) -> machine {
    machine state{.memory = {.base = memory_base, .bytes = std::vector<u8>(0x100)}};
    state.registers.at(std::to_underlying(gpr::rsp)) = stack_top;
    state.registers.at(std::to_underlying(argument)) = value;
    write(state.memory, {.address = stack_top, .size = width::qword}, return_address);
    return state;
}

auto register_of(const machine& state, gpr reg) -> u64 {
    return state.registers.at(std::to_underlying(reg));
}

TEST_CASE("a function with a branch returns to its caller with the result its path computes") {
    // test ecx, ecx; je zero; mov eax, 1; ret; zero: xor eax, eax; ret
    const function lifted =
        lifted_from({0x85, 0xc9, 0x74, 0x06, 0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3, 0x31, 0xc0, 0xc3});
    CHECK(lifted.instructions.size() == 6);

    machine nonzero = called_with(gpr::rcx, 5);
    CHECK(run(lifted, nonzero, step_limit) == return_address);
    CHECK(register_of(nonzero, gpr::rax) == 1);
    CHECK(register_of(nonzero, gpr::rsp) == stack_top + 8);

    machine zero = called_with(gpr::rcx, 0);
    CHECK(run(lifted, zero, step_limit) == return_address);
    CHECK(register_of(zero, gpr::rax) == 0);
}

TEST_CASE("a loop runs until its condition fails") {
    // xor eax, eax; again: add eax, ecx; dec ecx; jnz again; ret
    const function lifted = lifted_from({0x31, 0xc0, 0x01, 0xc8, 0xff, 0xc9, 0x75, 0xfa, 0xc3});

    machine state = called_with(gpr::rcx, 10);
    CHECK(run(lifted, state, step_limit) == return_address);
    CHECK(register_of(state, gpr::rax) == 55);
}

TEST_CASE("a loop that never exits stops at the step limit") {
    // again: jmp again
    const function lifted = lifted_from({0xeb, 0xfe});
    machine state = called_with(gpr::rcx, 0);
    const std::expected<u64, fault> outcome = run(lifted, state, step_limit);
    REQUIRE_FALSE(outcome.has_value());
    CHECK(outcome.error().kind == fault_kind::step_limit);
}

TEST_CASE("a memory access outside the machine's memory faults instead of reaching the host") {
    // mov eax, [rcx]; ret
    const function lifted = lifted_from({0x8b, 0x01, 0xc3});
    machine state = called_with(gpr::rcx, 0x5000);
    const std::expected<u64, fault> outcome = run(lifted, state, step_limit);
    REQUIRE_FALSE(outcome.has_value());
    CHECK(
        outcome.error()
        == fault{
            .kind = fault_kind::unmapped_memory,
            .address = code_address,
            .access = 0x5000,
        }
    );
}

TEST_CASE("a branch out of the function's code is refused") {
    // jmp +0x100
    const refusal found = refusal_of({0xe9, 0x00, 0x01, 0x00, 0x00});
    CHECK(found.reason == refusal_reason::branch_outside_function);
    CHECK(found.address == code_address);
}

TEST_CASE("code that runs past its end is refused") {
    // xor eax, eax
    CHECK(refusal_of({0x31, 0xc0}).reason == refusal_reason::runs_off_end);
}

TEST_CASE("a branch into the middle of another instruction is refused") {
    // je +1, into the immediate of: mov eax, 0xc3; ret
    const refusal found = refusal_of({0x74, 0x01, 0xb8, 0xc3, 0x00, 0x00, 0x00, 0xc3});
    CHECK(found.reason == refusal_reason::overlapping_instructions);
    CHECK(found.address == code_address + 3);
}

TEST_CASE("a refusal anywhere in the function refuses the function") {
    // test ecx, ecx; je away; ret; away: call rel32
    const refusal found = refusal_of({0x85, 0xc9, 0x74, 0x01, 0xc3, 0xe8, 0x00, 0x00, 0x00, 0x00});
    CHECK(found.reason == refusal_reason::call);
    CHECK(found.address == code_address + 5);
}

}
}
