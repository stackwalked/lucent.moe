#pragma once

#include <atomic>
#include <stop_token>

#include <lucent/os/unique_handle.hpp>

namespace lucent::kit::detail {

// How a kit worker ends the session while the lifecycle thread is blocked reading from the host:
// it marks the end requested, then cancels that thread's synchronous read, again and again until
// the lifecycle has left its wait and stops the workers. Again and again, because a cancel that
// lands just before the read starts finds nothing to cancel; the lifecycle checks the mark before
// each read, so one of the two always sees the other.
class session_end final {
public:
    // The lifecycle thread's handle, with the access CancelSynchronousIo needs.
    explicit session_end(os::unique_handle lifecycle_thread);

    session_end(const session_end&) = delete ("workers hold its address");
    auto operator=(const session_end&) -> session_end& = delete ("workers hold its address");
    session_end(session_end&&) = delete ("workers hold its address");
    auto operator=(session_end&&) -> session_end& = delete ("workers hold its address");
    ~session_end() = default;

    // The lifecycle thread, before each read from the host.
    auto is_requested() const -> bool;

    // A kit worker. Returns once stop is requested, which the lifecycle does after leaving its
    // wait for the host.
    auto request(const std::stop_token& stop) -> void;

private:
    os::unique_handle m_thread;
    std::atomic<bool> m_is_requested{false};
};

// A handle to the calling thread that other threads may use.
auto current_thread() -> result<os::unique_handle>;

}
