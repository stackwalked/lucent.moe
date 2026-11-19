#include <lucent/cs2-overlay/window_input.hpp>

#include <algorithm>
#include <bit>
#include <chrono>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/published.hpp>

// Removing the subclass in the wrong order, or one that is no longer ours, leaves the game's
// window calling into an unloaded module: a crash well after the unload, far from its cause.

namespace lucent::cs2::overlay {
namespace {

// What the window's own procedure saw, and what the procedure does on a test's message.
struct window_log {
    std::vector<UINT> seen;
    window_input* input = nullptr;
    // Untouched, and so a success, until the test's message arrives.
    result<void> unsubclassed_inside;
};

// A test's message: the window's own procedure unsubclasses from inside itself, so a call is in
// flight through ours.
constexpr UINT unsubclass_inside = WM_APP + 1;

auto log_of(HWND window) -> window_log& {
    return *std::bit_cast<window_log*>(GetWindowLongPtrW(window, GWLP_USERDATA));
}

auto CALLBACK own_procedure(HWND window, UINT id, WPARAM wparam, LPARAM lparam) -> LRESULT {
    if (GetWindowLongPtrW(window, GWLP_USERDATA) == 0) {
        return DefWindowProcW(window, id, wparam, lparam);
    }
    window_log& log = log_of(window);
    log.seen.push_back(id);
    if (id == unsubclass_inside) {
        log.unsubclassed_inside = log.input->unsubclass(std::chrono::milliseconds{0});
    }
    return DefWindowProcW(window, id, wparam, lparam);
}

auto CALLBACK other_procedure(HWND window, UINT id, WPARAM wparam, LPARAM lparam) -> LRESULT {
    return DefWindowProcW(window, id, wparam, lparam);
}

constexpr const wchar_t* class_name = L"lucent window_input test";

// A hidden top-level window of a class of its own, with user_data for its own procedure.
auto created_window(LONG_PTR user_data) -> HWND {
    const WNDCLASSEXW described{
        .cbSize = sizeof(WNDCLASSEXW),
        .style = 0,
        .lpfnWndProc = &own_procedure,
        .cbClsExtra = 0,
        .cbWndExtra = 0,
        .hInstance = GetModuleHandleW(nullptr),
        .hIcon = nullptr,
        .hCursor = nullptr,
        .hbrBackground = nullptr,
        .lpszMenuName = nullptr,
        .lpszClassName = class_name,
        .hIconSm = nullptr,
    };
    // A second registration fails as already registered, which leaves the first in place.
    RegisterClassExW(&described);
    HWND window = CreateWindowExW(
        0,
        class_name,
        nullptr,
        WS_OVERLAPPED,
        0,
        0,
        100,
        100,
        nullptr,
        nullptr,
        GetModuleHandleW(nullptr),
        nullptr
    );
    LUCENT_INVARIANT(window != nullptr);
    SetWindowLongPtrW(window, GWLP_USERDATA, user_data);
    return window;
}

class test_window final {
public:
    test_window()
        : m_window{created_window(std::bit_cast<LONG_PTR>(&m_log))} {}

    test_window(const test_window&) = delete ("owns the window");
    auto operator=(const test_window&) -> test_window& = delete ("owns the window");
    test_window(test_window&&) = delete ("owns the window");
    auto operator=(test_window&&) -> test_window& = delete ("owns the window");

    ~test_window() {
        SetWindowLongPtrW(m_window, GWLP_USERDATA, 0);
        DestroyWindow(m_window);
    }

    // What its own procedure saw; lives as long as the window.
    auto log() -> window_log& {
        return m_log;
    }

    auto handle() const -> HWND {
        return m_window;
    }

private:
    window_log m_log;
    HWND m_window = nullptr;
};

auto send(HWND window, UINT id, WPARAM wparam) -> void {
    SendMessageW(window, id, wparam, 0);
}

auto has_seen(const window_log& log, UINT id) -> bool {
    return std::ranges::contains(log.seen, id);
}

auto procedure_of(HWND window) -> LONG_PTR {
    return GetWindowLongPtrW(window, GWLP_WNDPROC);
}

TEST_CASE("the game's procedure gets what the menu doesn't take, and gets its place back") {
    test_window window;
    window_log& log = window.log();
    window_input input;
    log.input = &input;
    input.subclass(std::bit_cast<window_id>(window.handle()));
    REQUIRE(procedure_of(window.handle()) != std::bit_cast<LONG_PTR>(&own_procedure));

    send(window.handle(), WM_KEYDOWN, 'W');
    send(window.handle(), WM_KEYDOWN, VK_INSERT);
    CHECK(has_seen(log, WM_KEYDOWN));
    CHECK(std::ranges::count(log.seen, WM_KEYDOWN) == 1);
    CHECK(input.read()->is_menu_open);

    CHECK(input.unsubclass(std::chrono::milliseconds{0}).has_value());
    CHECK(procedure_of(window.handle()) == std::bit_cast<LONG_PTR>(&own_procedure));
}

TEST_CASE("typing the open menu wants is kept from the game, but the key's release is not") {
    test_window window;
    window_log& log = window.log();
    window_input input;
    log.input = &input;
    input.subclass(std::bit_cast<window_id>(window.handle()));
    send(window.handle(), WM_KEYDOWN, VK_INSERT);
    input.report({.consumed = input.read()->serial, .wants_mouse = false, .wants_keyboard = true});

    // The report is taken on the next message; this one isn't kept.
    send(window.handle(), WM_NULL, 0);
    send(window.handle(), WM_KEYDOWN, 'A');
    send(window.handle(), WM_CHAR, 'a');
    send(window.handle(), WM_KEYUP, 'A');
    CHECK_FALSE(has_seen(log, WM_KEYDOWN));
    CHECK_FALSE(has_seen(log, WM_CHAR));
    CHECK(has_seen(log, WM_KEYUP));
    CHECK(input.read()->events.size() == 1);

    CHECK(input.unsubclass(std::chrono::milliseconds{0}).has_value());
}

TEST_CASE("a subclass laid over ours stays, and unsubclassing fails so the module stays loaded") {
    const test_window window;
    window_input input;
    input.subclass(std::bit_cast<window_id>(window.handle()));
    SetWindowLongPtrW(window.handle(), GWLP_WNDPROC, std::bit_cast<LONG_PTR>(&other_procedure));

    const result<void> removed = input.unsubclass(std::chrono::milliseconds{0});
    REQUIRE_FALSE(removed.has_value());
    CHECK(removed.error().code == error_code::unsupported);
    CHECK(procedure_of(window.handle()) == std::bit_cast<LONG_PTR>(&other_procedure));
}

TEST_CASE("unsubclassing restores the procedure, then fails while a call is still inside ours") {
    test_window window;
    window_log& log = window.log();
    window_input input;
    log.input = &input;
    input.subclass(std::bit_cast<window_id>(window.handle()));

    send(window.handle(), unsubclass_inside, 0);
    REQUIRE_FALSE(log.unsubclassed_inside.has_value());
    CHECK(log.unsubclassed_inside.error().code == error_code::timed_out);
    CHECK(procedure_of(window.handle()) == std::bit_cast<LONG_PTR>(&own_procedure));
}

}
}
