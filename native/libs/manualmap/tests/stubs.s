.intel_syntax noprefix
.text

# attach_stub(const attach_args* args /*rcx*/) -> exit code
# struct attach_args { u64 image_base; u64 entry_point; u64 reserved; };
.globl attach_stub
attach_stub:
    sub rsp, 0x28
    mov rax, rcx
    mov rcx, qword ptr [rax]
    mov edx, 1
    mov r8, qword ptr [rax + 16]
    call qword ptr [rax + 8]
    add rsp, 0x28
    ret
.globl attach_stub_end
attach_stub_end:

# rtl_pc_trampoline(void* pc /*rcx*/, void** base_out /*rdx*/) -> void*
.p2align 4
.globl rtl_pc_trampoline
rtl_pc_trampoline:
    mov rax, qword ptr [rip + image_base]
    cmp rcx, rax
    jb 4f
    cmp rcx, qword ptr [rip + image_end]
    jae 4f
    test rdx, rdx
    jz 5f
    mov qword ptr [rdx], rax
5:
    ret
4:
    jmp qword ptr [rip + original]
.p2align 3
image_base: .quad 0
image_end: .quad 0
original: .quad 0
.globl rtl_pc_trampoline_end
rtl_pc_trampoline_end:
