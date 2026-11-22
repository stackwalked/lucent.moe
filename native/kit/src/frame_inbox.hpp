#pragma once

#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <stop_token>
#include <vector>

namespace lucent::kit::detail {

// Frames the host relayed on one route, from the lifecycle thread, which reads the session, to the
// worker that owns that route's client.
class frame_inbox final {
public:
    frame_inbox() = default;

    frame_inbox(const frame_inbox&) = delete ("both threads hold its address");
    auto operator=(const frame_inbox&) -> frame_inbox& = delete ("both threads hold its address");
    frame_inbox(frame_inbox&&) = delete ("both threads hold its address");
    auto operator=(frame_inbox&&) -> frame_inbox& = delete ("both threads hold its address");
    ~frame_inbox() = default;

    // The lifecycle thread. Past the bound the oldest frame goes: a host flooding the module can't
    // make it allocate without end, and only the newest frames matter.
    auto push(std::vector<std::byte> frame) -> void;

    // The owning worker: the oldest frame waiting, or nothing once `timeout` passed or stop was
    // requested.
    auto wait(const std::stop_token& stop, std::chrono::nanoseconds timeout)
        -> std::optional<std::vector<std::byte>>;

private:
    static constexpr isize max_frames = 64;

    std::mutex m_lock;
    std::condition_variable_any m_arrived;
    std::vector<std::vector<std::byte>> m_frames;
};

}
