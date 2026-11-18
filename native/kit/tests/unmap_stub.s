.intel_syntax noprefix
.text

# unmap_stub(const unmap_args* args /*rcx*/) -> never returns
# struct unmap_args { u64 image; u64 trampolines; u64 virtual_free; u64 exit_thread;
#                     u64 exit_code; };
# Runs from its own page, outside the image it frees; the page itself is left behind.
.globl unmap_stub
unmap_stub:
    sub rsp, 0x28
    mov rbx, rcx
    mov rcx, qword ptr [rbx]
    xor edx, edx
    mov r8d, 0x8000
    call qword ptr [rbx + 16]
    mov rcx, qword ptr [rbx + 8]
    test rcx, rcx
    jz 1f
    xor edx, edx
    mov r8d, 0x8000
    call qword ptr [rbx + 16]
1:
    mov ecx, dword ptr [rbx + 32]
    call qword ptr [rbx + 24]
    int3
.globl unmap_stub_end
unmap_stub_end:
