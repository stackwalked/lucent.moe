#pragma once

#include <array>
#include <type_traits>

namespace lucent::manualmap::detail {

// What the attach stub reads at its argument pointer. Fields must stay in this order and type: the
// stub reads them by hardcoded offsets.
struct attach_args {
    u64 function_table = 0;
    u64 function_count = 0;
    u64 image_base = 0;
    u64 add_function_table = 0;
    u64 entry_point = 0;
    u64 reserved = 0;
};

static_assert(std::is_trivially_copyable_v<attach_args>, "attach_args is written across processes");
static_assert(sizeof(attach_args) == 48, "attach_args layout is fixed");
static_assert(offsetof(attach_args, function_count) == 8, "stub reads function_count at [rbx+8]");
static_assert(offsetof(attach_args, image_base) == 16, "stub reads image_base at [rbx+16]");
static_assert(
    offsetof(attach_args, add_function_table) == 24, "stub reads add_function_table at [rbx+24]"
);
static_assert(offsetof(attach_args, entry_point) == 32, "stub reads entry_point at [rbx+32]");
static_assert(offsetof(attach_args, reserved) == 40, "stub reads reserved at [rbx+40]");

// attach_stub(const attach_args* args /*rcx*/) -> exit code.
//
// build: x86_64-pc-windows-msvc, Microsoft x64 calling convention
// found: tests/stubs.s, assembled with the pinned llvm-mc; bytes checked in tests/stubs_test.cpp
// breaks: attach() returns malformed or the target thread crashes
inline constexpr std::array<u8, 60> attach_stub_bytes = {
    0x53, // push rbx                     ; aligns rsp to 16
    0x48,
    0x83,
    0xec,
    0x20, // sub  rsp, 0x20               ; shadow space
    0x48,
    0x89,
    0xcb, // mov  rbx, rcx                ; args
    0x48,
    0x8b,
    0x0b, // mov  rcx, [rbx]              ; function_table
    0x48,
    0x85,
    0xc9, // test rcx, rcx
    0x74,
    0x0f, // jz   call_entry              ; no .pdata
    0x48,
    0x8b,
    0x53,
    0x08, // mov  rdx, [rbx+8]            ; function_count
    0x4c,
    0x8b,
    0x43,
    0x10, // mov  r8,  [rbx+16]           ; image_base
    0xff,
    0x53,
    0x18, // call [rbx+24]                ; RtlAddFunctionTable
    0x84,
    0xc0, // test al, al
    0x74,
    0x12, // jz   table_failed
    0x48,
    0x8b,
    0x4b,
    0x10, // call_entry: mov rcx, [rbx+16]; hinstDLL = image_base
    0xba,
    0x01,
    0x00,
    0x00,
    0x00, // mov  edx, 1                  ; DLL_PROCESS_ATTACH
    0x4c,
    0x8b,
    0x43,
    0x28, // mov  r8,  [rbx+40]           ; reserved
    0xff,
    0x53,
    0x20, // call [rbx+32]                ; entry point; returns BOOL in eax
    0xeb,
    0x05, // jmp  done
    0xb8,
    0x02,
    0x00,
    0x00,
    0x00, // table_failed: mov eax, 2
    0x48,
    0x83,
    0xc4,
    0x20, // done: add rsp, 0x20
    0x5b, // pop  rbx
    0xc3, // ret                          ; eax is the thread's exit code
};

inline constexpr usize attach_args_offset = 0x40;
inline constexpr usize attach_region_size = attach_args_offset + sizeof(attach_args);

// rtl_pc_trampoline(void* pc /*rcx*/, void** base_out /*rdx*/) -> void*.
//
// The three u64 data words after the code are patched by install_rtl_pc_trampoline.
//
// build: x86_64-pc-windows-msvc, Microsoft x64 calling convention
// found: tests/stubs.s, assembled with the pinned llvm-mc; bytes checked in tests/stubs_test.cpp
// breaks: catch-by-type inside a mapped image: the loader doesn't know the image, so the real
//         RtlPcToFileHeader returns null and type matching uses image base 0
inline constexpr std::array<u8, 64> rtl_pc_trampoline_bytes = {
    0x48,
    0x8b,
    0x05,
    0x21,
    0x00,
    0x00,
    0x00, // mov  rax, [rip+0x21]   ; image_base (+0x28)
    0x48,
    0x39,
    0xc1, // cmp  rcx, rax
    0x72,
    0x12, // jb   not_ours
    0x48,
    0x3b,
    0x0d,
    0x1d,
    0x00,
    0x00,
    0x00, // cmp  rcx, [rip+0x1D]   ; image_end (+0x30)
    0x73,
    0x09, // jae  not_ours
    0x48,
    0x85,
    0xd2, // test rdx, rdx
    0x74,
    0x03, // jz   done
    0x48,
    0x89,
    0x02, // mov  [rdx], rax        ; *base_out = image_base
    0xc3, // done: ret              ; rax = image_base
    0xff,
    0x25,
    0x14,
    0x00,
    0x00,
    0x00, // not_ours: jmp [rip+0x14] ; original (+0x38)
    0x0f,
    0x1f,
    0x40,
    0x00, // nop                    ; aligns data to 8
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // image_base (+0x28)
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // image_end (+0x30)
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0, // original (+0x38)
};

inline constexpr usize trampoline_image_base_offset = 0x28;
inline constexpr usize trampoline_image_end_offset = 0x30;
inline constexpr usize trampoline_original_offset = 0x38;
inline constexpr usize trampoline_size = 0x40;

}
