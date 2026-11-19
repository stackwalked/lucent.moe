#include <lucent/refract/refusal.hpp>

#include <array>
#include <cstddef>
#include <expected>
#include <span>
#include <string_view>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/refract/instruction.hpp>

namespace lucent::refract {
namespace {

constexpr u64 code_address = 0x1'4000'1000;

auto refusal_of(std::span<const u8> code) -> refusal {
    std::vector<std::byte> bytes;
    bytes.reserve(code.size());
    for (const u8 value : code) {
        bytes.push_back(std::byte{value});
    }
    const std::expected<instruction, refusal> lifted = lift_instruction(bytes, code_address);
    REQUIRE(!lifted.has_value());
    return lifted.error();
}

struct refused {
    std::string_view assembly;
    std::vector<u8> code;
    refusal_reason reason = refusal_reason::undecodable;
};

TEST_CASE("each instruction outside the subset is refused with the reason it falls outside") {
    const std::vector<refused> cases{
        {.assembly = "0f, cut short", .code = {0x0f}, .reason = refusal_reason::undecodable},
        {
            .assembly = "movsb",
            .code = {0xa4},
            .reason = refusal_reason::unsupported_instruction,
        },
        {
            .assembly = "div ecx",
            .code = {0xf7, 0xf1},
            .reason = refusal_reason::unsupported_instruction,
        },
        {
            .assembly = "movaps xmm0, xmm1",
            .code = {0x0f, 0x28, 0xc1},
            .reason = refusal_reason::unsupported_instruction,
        },
        {
            .assembly = "imul ecx",
            .code = {0xf7, 0xe9},
            .reason = refusal_reason::unsupported_operand,
        },
        {
            .assembly = "push ax",
            .code = {0x66, 0x50},
            .reason = refusal_reason::unsupported_operand,
        },
        {
            .assembly = "pop qword [rax]",
            .code = {0x8f, 0x00},
            .reason = refusal_reason::unsupported_operand,
        },
        {
            .assembly = "lock add [rax], ecx",
            .code = {0xf0, 0x01, 0x08},
            .reason = refusal_reason::unsupported_prefix,
        },
        {
            .assembly = "rep stosb",
            .code = {0xf3, 0xaa},
            .reason = refusal_reason::unsupported_prefix,
        },
        {
            .assembly = "mov eax, fs:[0]",
            .code = {0x64, 0x8b, 0x04, 0x25, 0x00, 0x00, 0x00, 0x00},
            .reason = refusal_reason::segment_override,
        },
        {
            .assembly = "mov rax, gs:[0x30]",
            .code = {0x65, 0x48, 0x8b, 0x04, 0x25, 0x30, 0x00, 0x00, 0x00},
            .reason = refusal_reason::segment_override,
        },
        {
            .assembly = "lea eax, [ecx]",
            .code = {0x67, 0x8d, 0x01},
            .reason = refusal_reason::address_size_override,
        },
        {
            .assembly = "mov ah, 1",
            .code = {0xb4, 0x01},
            .reason = refusal_reason::high_byte_register,
        },
        {
            .assembly = "movzx eax, bh",
            .code = {0x0f, 0xb6, 0xc7},
            .reason = refusal_reason::high_byte_register,
        },
        {
            .assembly = "mov rax, cr0",
            .code = {0x0f, 0x20, 0xc0},
            .reason = refusal_reason::unsupported_register,
        },
        {
            .assembly = "call rel32",
            .code = {0xe8, 0x00, 0x00, 0x00, 0x00},
            .reason = refusal_reason::call,
        },
        {.assembly = "call rax", .code = {0xff, 0xd0}, .reason = refusal_reason::call},
        {
            .assembly = "jmp rax",
            .code = {0xff, 0xe0},
            .reason = refusal_reason::indirect_branch,
        },
        {
            .assembly = "jmp [rip]",
            .code = {0xff, 0x25, 0x00, 0x00, 0x00, 0x00},
            .reason = refusal_reason::indirect_branch,
        },
    };
    for (const refused& each : cases) {
        INFO(each.assembly);
        const refusal found = refusal_of(each.code);
        CHECK(found.reason == each.reason);
        CHECK(found.address == code_address);
    }
}

TEST_CASE("a refusal names the mnemonic it refused") {
    constexpr std::array<u8, 2> division{0xf7, 0xf1};
    CHECK(refusal_of(division).mnemonic == "div");
}

}
}
