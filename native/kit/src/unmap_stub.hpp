#pragma once

#include <array>
#include <cstddef>
#include <type_traits>

namespace lucent::kit::detail {

// What the unmap stub reads at its argument pointer, by hardcoded offsets.
struct unmap_args {
    u64 image = 0;
    // 0 when the mapper made none.
    u64 trampolines = 0;
    u64 virtual_free = 0;
    u64 exit_thread = 0;
    u64 exit_code = 0;
};

static_assert(std::is_trivially_copyable_v<unmap_args>, "the stub reads unmap_args as raw bytes");
static_assert(sizeof(unmap_args) == 40, "unmap_args layout is fixed");
static_assert(offsetof(unmap_args, trampolines) == 8, "stub reads trampolines at [rbx+8]");
static_assert(offsetof(unmap_args, virtual_free) == 16, "stub reads virtual_free at [rbx+16]");
static_assert(offsetof(unmap_args, exit_thread) == 24, "stub reads exit_thread at [rbx+24]");
static_assert(offsetof(unmap_args, exit_code) == 32, "stub reads exit_code at [rbx+32]");

// unmap_stub(const unmap_args* args /*rcx*/), never returns: VirtualFree(image), VirtualFree
// (trampolines) unless 0, then ExitThread(exit_code). It runs from a page of its own outside the
// image, a page it can't free without returning into freed memory, so that page is left behind.
//
// build: x86_64-pc-windows-msvc, Microsoft x64 calling convention, entered by `call` (rsp%16 == 8)
// found: tests/unmap_stub.s, assembled with the pinned llvm-mc; run in tests/unmap_stub_test.cpp
// breaks: a mapped module's unload crashes the target, or leaves the image mapped
inline constexpr std::array<u8, 48> unmap_stub_bytes = {
    0x48,
    0x83,
    0xec,
    0x28, // sub  rsp, 0x28              ; shadow space, rsp%16 == 0
    0x48,
    0x89,
    0xcb, // mov  rbx, rcx               ; args; never returns, so no save
    0x48,
    0x8b,
    0x0b, // mov  rcx, [rbx]             ; image
    0x31,
    0xd2, // xor  edx, edx
    0x41,
    0xb8,
    0x00,
    0x80,
    0x00,
    0x00, // mov  r8d, MEM_RELEASE
    0xff,
    0x53,
    0x10, // call [rbx+16]               ; VirtualFree
    0x48,
    0x8b,
    0x4b,
    0x08, // mov  rcx, [rbx+8]           ; trampolines
    0x48,
    0x85,
    0xc9, // test rcx, rcx
    0x74,
    0x0b, // jz   exit
    0x31,
    0xd2, // xor  edx, edx
    0x41,
    0xb8,
    0x00,
    0x80,
    0x00,
    0x00, // mov  r8d, MEM_RELEASE
    0xff,
    0x53,
    0x10, // call [rbx+16]               ; VirtualFree
    0x8b,
    0x4b,
    0x20, // exit: mov ecx, [rbx+32]     ; exit_code
    0xff,
    0x53,
    0x18, // call [rbx+24]               ; ExitThread
    0xcc, // int3                        ; unreachable
};

// The stub's page: code first, its arguments after it.
inline constexpr usize unmap_args_offset = 0x40;
inline constexpr usize unmap_page_size = 0x1000;

static_assert(unmap_stub_bytes.size() <= unmap_args_offset, "the arguments follow the code");

}
