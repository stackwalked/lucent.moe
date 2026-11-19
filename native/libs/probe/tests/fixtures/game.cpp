// A stand-in for a game module, built as games ship (RTTI on), for the probe to read from disk.
// Nothing calls into it; its exports only keep the classes' vtables and the strings linked in.

#include <array>
#include <string_view>

// NOLINTBEGIN(misc-use-internal-linkage): an anonymous namespace would change the RTTI names.
namespace game {

class system {
public:
    virtual auto name() const -> const char* = 0;
    virtual auto priority() const -> int = 0;

protected:
    constexpr system() = default;
    constexpr ~system() = default;
    system(const system&) = default;
    auto operator=(const system&) -> system& = default;
    system(system&&) = default;
    auto operator=(system&&) -> system& = default;
};

class listener {
public:
    virtual auto on_event(int code) const -> int = 0;

protected:
    constexpr listener() = default;
    constexpr ~listener() = default;
    listener(const listener&) = default;
    auto operator=(const listener&) -> listener& = default;
    listener(listener&&) = default;
    auto operator=(listener&&) -> listener& = default;
};

class client_mode final : public system {
public:
    auto name() const -> const char* override {
        return "fixture client mode";
    }

    auto priority() const -> int override {
        return 7;
    }
};

// Two bases with virtual functions: one vtable per base subobject.
class hud final : public system, public listener {
public:
    auto name() const -> const char* override {
        return "fixture hud";
    }

    auto priority() const -> int override {
        return 3;
    }

    auto on_event(int code) const -> int override {
        return code + 1;
    }
};

constinit const client_mode the_client_mode{};
constinit const hud the_hud{};

}

// NOLINTEND(misc-use-internal-linkage)

extern "C" {
__declspec(dllexport) auto fixture_client_mode() -> const game::system*;
__declspec(dllexport) auto fixture_hud() -> const game::system*;
__declspec(dllexport) auto fixture_hud_listener() -> const game::listener*;
__declspec(dllexport) auto fixture_marker() -> int;
__declspec(dllexport) auto fixture_row(int slot) -> const float*;
__declspec(dllexport) auto fixture_row_again(int slot) -> const float*;
__declspec(dllexport) auto fixture_other_row(int slot) -> const float*;
__declspec(dllexport) auto fixture_entry(unsigned handle, const char* chunk) -> const char*;
__declspec(dllexport) auto fixture_entry_apart(unsigned handle, const char* chunk) -> const char*;
__declspec(dllexport) auto fixture_entry_mismatched(unsigned handle, const char* chunk) -> const
    char*;
__declspec(dllexport) auto fixture_field(const char* object) -> const char*;
__declspec(dllexport) auto fixture_forward() -> int;
__declspec(dllexport) auto fixture_sink(const char* text) -> int;
__declspec(dllexport) auto fixture_describe() -> int;
__declspec(dllexport) extern const std::array<float, 64> fixture_rows;
__declspec(dllexport) extern const std::array<float, 64> fixture_other_rows;
}

// Read only by the accessors above, by name.
constinit const std::array<float, 64> fixture_rows{};
constinit const std::array<float, 64> fixture_other_rows{};

// Code of known bytes for the byte pattern tests: B8 67 45 23 01 (mov eax, 0x1234567), C3 (ret).
[[gnu::naked]] auto fixture_marker() -> int {
    // NOLINTNEXTLINE(portability-no-assembler): the test needs code whose bytes it knows.
    __asm__("movl $0x01234567, %eax\n\tret");
}

// Code of known instructions for the instruction pattern tests. Nothing runs it.
// NOLINTBEGIN(portability-no-assembler): the tests need code whose instructions they know.

// Indexed accessors over tables of 64-byte rows, shaped as cs2's view matrix accessor is.
[[gnu::naked]] auto fixture_row(int /*slot*/) -> const float* {
    __asm__("movslq %ecx, %rax\n\tleaq fixture_rows(%rip), %rcx\n\tshlq $6, %rax\n\t"
            "addq %rcx, %rax\n\tretq");
}

[[gnu::naked]] auto fixture_row_again(int /*slot*/) -> const float* {
    __asm__("movslq %ecx, %rax\n\tleaq fixture_rows(%rip), %rcx\n\tshlq $6, %rax\n\t"
            "addq %rcx, %rax\n\tretq");
}

[[gnu::naked]] auto fixture_other_row(int /*slot*/) -> const float* {
    __asm__("movslq %ecx, %rax\n\tleaq fixture_other_rows(%rip), %rcx\n\tshlq $6, %rax\n\t"
            "addq %rcx, %rax\n\tretq");
}

// An entry of a chunk of 0x70-byte records: the index masked in ecx, scaled through rcx.
[[gnu::naked]] auto fixture_entry(unsigned /*handle*/, const char* /*chunk*/) -> const char* {
    __asm__("andl $0x1ff, %ecx\n\timulq $0x70, %rcx, %rax\n\taddq %rdx, %rax\n\tretq");
}

// The same with an unrelated instruction between the mask and the scale.
[[gnu::naked]] auto fixture_entry_apart(unsigned /*handle*/, const char* /*chunk*/) -> const char* {
    __asm__("andl $0x1ff, %ecx\n\tshrl $9, %edx\n\timulq $0x70, %rcx, %rax\n\tretq");
}

// The mask in one register and the scale through another.
[[gnu::naked]] auto fixture_entry_mismatched(unsigned /*handle*/, const char* /*chunk*/) -> const
    char* {
    __asm__("andl $0x1ff, %ecx\n\timulq $0x30, %rdx, %rax\n\tretq");
}

[[gnu::naked]] auto fixture_field(const char* /*object*/) -> const char* {
    __asm__("movq 0x48(%rcx), %rax\n\tretq");
}

[[gnu::naked]] auto fixture_forward() -> int {
    __asm__("callq fixture_marker\n\tretq");
}

// NOLINTEND(portability-no-assembler)

// Kept out of line: inlined at /O2, fixture_describe folds to a constant with no call, string
// reference or unwind data left to find.
[[gnu::noinline]] auto fixture_sink(const char* text) -> int {
    return static_cast<int>(std::string_view{text}.size());
}

// Names a build path, as cs2's code names its source files, in a function with unwind data: it
// keeps the first call's result across the second.
auto fixture_describe() -> int {
    return fixture_sink(R"(C:\buildworker\fixture\src\game\client\view.cpp)")
           + fixture_sink("fixture other");
}

auto fixture_client_mode() -> const game::system* {
    return &game::the_client_mode;
}

auto fixture_hud() -> const game::system* {
    return &game::the_hud;
}

auto fixture_hud_listener() -> const game::listener* {
    return &game::the_hud;
}
