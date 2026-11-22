#include "frame_inbox.hpp"

#include <chrono>
#include <cstddef>
#include <mutex>
#include <optional>
#include <stop_token>
#include <utility>
#include <vector>

namespace lucent::kit::detail {

auto frame_inbox::push(std::vector<std::byte> frame) -> void {
    {
        const std::scoped_lock<std::mutex> held{m_lock};
        if (std::ssize(m_frames) >= max_frames) {
            m_frames.erase(m_frames.begin());
        }
        m_frames.push_back(std::move(frame));
    }
    m_arrived.notify_one();
}

auto frame_inbox::wait(const std::stop_token& stop, std::chrono::nanoseconds timeout)
    -> std::optional<std::vector<std::byte>> {
    std::unique_lock<std::mutex> held{m_lock};
    if (!m_arrived.wait_for(held, stop, timeout, [this] { return !m_frames.empty(); })) {
        return std::nullopt;
    }
    std::vector<std::byte> frame = std::move(m_frames.front());
    m_frames.erase(m_frames.begin());
    return frame;
}

}
