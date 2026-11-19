#include <lucent/cs2-overlay/window_input.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <expected>
#include <limits>
#include <string>
#include <string_view>
#include <tuple>

#include <Windows.h>

#include <imm.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/cs2-overlay/input_collector.hpp>
#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/kit/published.hpp>

namespace lucent::cs2::overlay {
namespace {

// The window_input whose procedure is the window's. Stored before the procedure is installed and
// never cleared: a call can only arrive through the procedure, which only that object installs.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the plain function Windows calls can reach its object no other way; the attachment owns what it points at.
constinit std::atomic<window_input*> subclassing{nullptr};

// Counts one call inside the procedure for as long as it runs, the window's own procedure
// included: a modal loop in there (a window drag) returns into ours much later.
class counted_call final {
public:
    explicit counted_call(std::atomic<i32>& count)
        : m_count{&count} {
        // Acq_rel: pairs with unsubclass()'s acquire load, so a call it sees ended has ended.
        m_count->fetch_add(1, std::memory_order_acq_rel);
    }

    counted_call(const counted_call&) = delete ("counts one call");
    auto operator=(const counted_call&) -> counted_call& = delete ("counts one call");
    counted_call(counted_call&&) = delete ("counts one call");
    auto operator=(counted_call&&) -> counted_call& = delete ("counts one call");

    ~counted_call() {
        m_count->fetch_sub(1, std::memory_order_release);
    }

private:
    std::atomic<i32>* m_count;
};

auto system_click_rules() -> click_rules {
    return {
        .interval = std::chrono::milliseconds{GetDoubleClickTime()},
        .area = {
            .x = static_cast<f32>(GetSystemMetrics(SM_CXDOUBLECLK)),
            .y = static_cast<f32>(GetSystemMetrics(SM_CYDOUBLECLK)),
        },
    };
}

// Messages that can change the feed: worth publishing it after.
auto is_input_message(u32 id) -> bool {
    return (id >= WM_MOUSEFIRST && id <= WM_MOUSELAST)
           || (id >= WM_KEYFIRST && id <= WM_KEYLAST)
           || (id >= WM_IME_STARTCOMPOSITION && id <= WM_IME_KEYLAST)
           || id == WM_KILLFOCUS
           || id == WM_ACTIVATEAPP;
}

// NOLINTBEGIN(cppcoreguidelines-pro-type-union-access): RAWINPUT is Win32's tagged union; a member is read only once header.dwType names it.

auto is_raw_mouse_release(const RAWMOUSE& mouse) -> bool {
    constexpr USHORT releases = RI_MOUSE_LEFT_BUTTON_UP
                                | RI_MOUSE_RIGHT_BUTTON_UP
                                | RI_MOUSE_MIDDLE_BUTTON_UP
                                | RI_MOUSE_BUTTON_4_UP
                                | RI_MOUSE_BUTTON_5_UP;
    return (mouse.usButtonFlags & releases) != 0;
}

// WM_INPUT, sorted as the window messages it stands beside are: a game reading raw input this way
// is kept from it the same way. Releases pass, as theirs do.
auto raw_input_kind(u64 wparam, i64 lparam) -> message_kind {
    // RIM_INPUTSINK: the window is in the background, where the menu takes nothing.
    if (GET_RAWINPUT_CODE_WPARAM(wparam) != RIM_INPUT) {
        return message_kind::other;
    }
    RAWINPUT raw{};
    UINT size = sizeof(raw);
    // Larger HID reports don't fit and fail here: they are no mouse or keyboard.
    const UINT copied = GetRawInputData(
        std::bit_cast<HRAWINPUT>(lparam), RID_INPUT, &raw, &size, sizeof(RAWINPUTHEADER)
    );
    if (copied == std::numeric_limits<UINT>::max()) {
        return message_kind::other;
    }
    switch (raw.header.dwType) {
    case RIM_TYPEMOUSE:
        return is_raw_mouse_release(raw.data.mouse) ? message_kind::other : message_kind::mouse;
    case RIM_TYPEKEYBOARD:
        if ((raw.data.keyboard.Flags & RI_KEY_BREAK) != 0) {
            return message_kind::other;
        }
        return raw.data.keyboard.VKey == VK_INSERT ? message_kind::menu_key
                                                   : message_kind::keyboard;
    default:
        return message_kind::other;
    }
}

// NOLINTEND(cppcoreguidelines-pro-type-union-access)

struct ime_strings {
    std::wstring units;
    // GCS_CURSORPOS: UTF-16 units into the composition; zero for the result string.
    isize caret = 0;
};

// One of the input method's strings (GCS_COMPSTR, GCS_RESULTSTR); empty when it has none.
auto ime_string(HWND window, DWORD kind) -> ime_strings {
    HIMC context = ImmGetContext(window);
    if (context == nullptr) {
        return {};
    }
    ime_strings read;
    const LONG bytes = ImmGetCompositionStringW(context, kind, nullptr, 0);
    if (bytes > 0) {
        read.units.resize(narrow<usize>(bytes) / sizeof(wchar_t));
        std::ignore =
            ImmGetCompositionStringW(context, kind, read.units.data(), narrow<DWORD>(bytes));
        if (kind == GCS_COMPSTR) {
            const LONG caret = ImmGetCompositionStringW(context, GCS_CURSORPOS, nullptr, 0);
            read.caret = std::clamp<isize>(caret, 0, std::ssize(read.units));
        }
    }
    std::ignore = ImmReleaseContext(window, context);
    return read;
}

}

window_input::window_input()
    : m_collector{system_click_rules()}
    , m_feed{input_feed{}}
    , m_report{menu_report{}} {}

// The procedure the window calls instead of its own, and the one friend of window_input that
// reaches its handle().
class window_procedure final {
public:
    static auto CALLBACK call(HWND window, UINT id, WPARAM wparam, LPARAM lparam) noexcept
        -> LRESULT {
        const window_message message{
            .id = id,
            .wparam = wparam,
            .lparam = lparam,
            .time = static_cast<u32>(GetMessageTime()),
        };
        return subclassing.load(std::memory_order_acquire)
            ->handle(std::bit_cast<window_id>(window), message);
    }
};

auto window_input::subclass(window_id window) -> void {
    if (m_window != window_id{}) {
        return;
    }
    m_window = window;
    auto* const handle = std::bit_cast<HWND>(window);
    subclassing.store(this, std::memory_order_release);
    // The original is in place before ours can be called: a message that slips in between the two
    // calls below finds it there.
    m_original.store(
        std::bit_cast<uptr>(GetWindowLongPtrW(handle, GWLP_WNDPROC)), std::memory_order_release
    );
    const LONG_PTR replaced =
        SetWindowLongPtrW(handle, GWLP_WNDPROC, std::bit_cast<LONG_PTR>(&window_procedure::call));
    // Zero is a failure: no window has a null procedure.
    if (replaced == 0) {
        return;
    }
    m_original.store(std::bit_cast<uptr>(replaced), std::memory_order_release);
    m_is_subclassed = true;
}

auto window_input::unsubclass(std::chrono::milliseconds patience) -> result<void> {
    if (!m_is_subclassed) {
        return {};
    }
    auto* const window = std::bit_cast<HWND>(m_window);
    // A destroyed window calls nothing any more; only calls already inside are waited for.
    if (IsWindow(window) != FALSE) {
        const auto original = std::bit_cast<LONG_PTR>(m_original.load(std::memory_order_acquire));
        const LONG_PTR replaced = SetWindowLongPtrW(window, GWLP_WNDPROC, original);
        if (replaced != std::bit_cast<LONG_PTR>(&window_procedure::call)) {
            // Someone subclassed over ours and still calls it: theirs goes back.
            std::ignore = SetWindowLongPtrW(window, GWLP_WNDPROC, replaced);
            return std::unexpected(error{.code = error_code::unsupported});
        }
    }
    m_is_subclassed = false;
    const auto deadline = std::chrono::steady_clock::now() + patience;
    while (m_in_flight.load(std::memory_order_acquire) != 0) {
        if (std::chrono::steady_clock::now() >= deadline) {
            return std::unexpected(error{.code = error_code::timed_out});
        }
        Sleep(1);
    }
    return {};
}

auto window_input::read() -> kit::published<input_feed>::reading {
    return m_feed.read();
}

auto window_input::report(const menu_report& reported) -> void {
    // Never refused: the window's thread, the one reader, pins at most one slot at a time.
    std::ignore = m_report.publish(reported);
}

auto window_input::handle(window_id window, const window_message& message) -> i64 {
    const counted_call counted{m_in_flight};
    bool is_kept = false;
    // A fault in our part passes the message on untouched; the game's procedure runs outside.
    std::ignore = contain([&] { is_kept = take(window, message); });
    auto* const handle = std::bit_cast<HWND>(window);
    const auto id = static_cast<UINT>(message.id);
    if (is_kept) {
        // WM_INPUT must reach DefWindowProc, which frees what the system holds for it.
        return id == WM_INPUT ? DefWindowProcW(handle, id, message.wparam, message.lparam) : 0;
    }
    const auto original = std::bit_cast<WNDPROC>(m_original.load(std::memory_order_acquire));
    return CallWindowProcW(original, handle, id, message.wparam, message.lparam);
}

auto window_input::take_composition(window_id window, const window_message& message) -> void {
    auto* const handle = std::bit_cast<HWND>(window);
    const auto changed = static_cast<DWORD>(message.lparam);
    if ((changed & GCS_RESULTSTR) != 0) {
        m_collector.record_commit(to_utf8(ime_string(handle, GCS_RESULTSTR).units));
    }
    if ((changed & GCS_COMPSTR) != 0) {
        const ime_strings composing = ime_string(handle, GCS_COMPSTR);
        const std::wstring_view before =
            std::wstring_view{composing.units}.substr(0, narrow<usize>(composing.caret));
        m_collector.record_composition({
            .utf8 = to_utf8(composing.units),
            .caret = std::ssize(to_utf8(before)),
        });
    }
}

auto window_input::take(window_id window, const window_message& message) -> bool {
    if (message.id == WM_IME_COMPOSITION) {
        take_composition(window, message);
    } else if (message.id == WM_IME_ENDCOMPOSITION) {
        m_collector.record_composition({});
    }
    m_collector.record(message);
    const message_kind kind =
        message.id == WM_INPUT ? raw_input_kind(message.wparam, message.lparam) : kind_of(message);
    {
        const kit::published<menu_report>::reading reported = m_report.read();
        m_collector.acknowledge(*reported);
    }
    if (is_input_message(message.id)) {
        // Never refused, as report()'s; a refusal would only delay the feed to the next message.
        std::ignore = m_feed.publish(m_collector.feed());
    }
    return m_collector.should_keep_from_game(kind);
}

}
