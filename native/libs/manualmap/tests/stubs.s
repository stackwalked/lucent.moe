.intel_syntax noprefix
.text

# attach_stub(const attach_args* args /*rcx*/) -> exit code
# struct attach_args { u64 function_table; u64 function_count; u64 image_base;
#                      u64 add_function_table; u64 entry_point; u64 reserved; };
.globl attach_stub
attach_stub:
    push rbx
    sub rsp, 0x20
    mov rbx, rcx
    mov rcx, qword ptr [rbx]
    test rcx, rcx
    jz 1f
    mov rdx, qword ptr [rbx + 8]
    mov r8, qword ptr [rbx + 16]
    call qword ptr [rbx + 24]
    test al, al
    jz 2f
1:
    mov rcx, qword ptr [rbx + 16]
    mov edx, 1
    mov r8, qword ptr [rbx + 40]
    call qword ptr [rbx + 32]
    jmp 3f
2:
    mov eax, 2
3:
    add rsp, 0x20
    pop rbx
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
