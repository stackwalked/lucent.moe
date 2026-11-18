// A stand-in for a game module, built as games ship (RTTI on), for the probe to read from disk.
// Nothing calls into it; its exports only keep the classes' vtables and the strings linked in.

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
}

// Code of known bytes for the byte pattern tests: B8 67 45 23 01 (mov eax, 0x1234567), C3 (ret).
[[gnu::naked]] auto fixture_marker() -> int {
    // NOLINTNEXTLINE(portability-no-assembler): the test needs code whose bytes it knows.
    __asm__("movl $0x01234567, %eax\n\tret");
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
