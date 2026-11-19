#pragma once

#include <chrono>

#include <lucent/d3d11/renderer.hpp>

namespace lucent::cs2::overlay {

// One drawn frame's cost, as the overlay measured it.
struct frame_cost {
    // Declaring and recording everything the frame draws.
    std::chrono::nanoseconds record{};
    // render(): checking the frame and submitting it to the device.
    std::chrono::nanoseconds submit{};
    d3d11::renderer_stats renderer;
    // Atlas pages cleared to make room, since the text system was made.
    i64 evictions = 0;
};

// The overlay's frame stats for whoever tunes it: averaged over a second and sent over the dev
// channel. Defined in dev builds only, and called only from `if constexpr (kit::is_dev_build)`, so
// none of its text reaches a release image.
class dev_stats final {
public:
    explicit dev_stats(std::chrono::steady_clock::time_point now);

    auto add(const frame_cost& cost, std::chrono::steady_clock::time_point now) -> void;

private:
    std::chrono::steady_clock::time_point m_window_start;
    isize m_frames = 0;
    std::chrono::nanoseconds m_record{};
    std::chrono::nanoseconds m_submit{};
    std::chrono::nanoseconds m_gpu{};
    isize m_timed_frames = 0;
    isize m_draw_calls = 0;
    isize m_passes = 0;
};

}
