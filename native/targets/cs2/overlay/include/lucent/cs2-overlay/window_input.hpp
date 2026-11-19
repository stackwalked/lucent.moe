#pragma once

#include <atomic>
#include <chrono>

#include <lucent/cs2-overlay/input_collector.hpp>
#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/kit/published.hpp>

namespace lucent::cs2::overlay {

// A window, by its HWND's bits: public headers stay clear of Windows.h.
enum class window_id : uptr {};

class window_procedure;

// The game window's procedure, subclassed for the menu: every message passes through an
// input_collector on the window's thread, which publishes the feed for the presenting thread and
// keeps from the game what the menu has. Public Win32 only (GWLP_WNDPROC), no game fact.
//
// Threads: subclass(), read() and report() on the presenting thread; the procedure on the
// window's; unsubclass() on the lifecycle thread once the presenting thread can no longer call in.
// One window_input subclasses at a time: the procedure finds it through one global.
class window_input final {
public:
    window_input();
    window_input(const window_input&) = delete ("the window's procedure holds its address");
    auto operator=(const window_input&)
        -> window_input& = delete ("the window's procedure holds its address");
    window_input(window_input&&) = delete ("the window's procedure holds its address");
    auto operator=(window_input&&)
        -> window_input& = delete ("the window's procedure holds its address");
    // Only once unsubclass() has succeeded, or if subclass() never ran.
    ~window_input() = default;

    // Subclasses window, the first time it is called; later calls change nothing.
    auto subclass(window_id window) -> void;

    // Gives the window its procedure back, if the procedure there is still ours, then waits up to
    // patience for every call already inside ours to return. A failure (a subclass laid over ours,
    // a call still inside) means the window may still call this module: it must stay loaded and
    // this object allocated.
    auto unsubclass(std::chrono::milliseconds patience) -> result<void>;

    auto read() -> kit::published<input_feed>::reading;
    auto report(const menu_report& reported) -> void;

private:
    // The procedure installed in the window, which calls handle().
    friend class window_procedure;

    // The window's thread: the message's result, from the window's own procedure unless kept.
    auto handle(window_id window, const window_message& message) -> i64;
    // Records the message and publishes the feed; whether the game is kept from it.
    auto take(const window_message& message) -> bool;

    // The window's thread only.
    input_collector m_collector;
    kit::published<input_feed> m_feed;
    kit::published<menu_report> m_report;
    // Written by subclass() on the presenting thread; read by unsubclass() once that thread is out.
    window_id m_window{};
    bool m_is_subclassed = false;
    // The window's own procedure, which ours calls on: a WNDPROC.
    std::atomic<uptr> m_original{0};
    // Calls inside our procedure now, the original's included.
    std::atomic<i32> m_in_flight{0};
};

}
