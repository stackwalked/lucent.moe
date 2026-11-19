#include "dev_stats.hpp"

#include <chrono>
#include <format>
#include <ratio>

#include <lucent/kit/dev_channel.hpp>

// Dev builds only: the module's CMakeLists leaves this file out of every other configuration.

namespace lucent::cs2::overlay {
namespace {

constexpr std::chrono::seconds window{1};

auto milliseconds(std::chrono::nanoseconds total, isize count) -> f64 {
    return count > 0
               ? std::chrono::duration<f64, std::milli>{total}.count() / static_cast<f64>(count)
               : 0.0;
}

}

dev_stats::dev_stats(std::chrono::steady_clock::time_point now)
    : m_window_start{now} {}

auto dev_stats::add(const frame_cost& cost, std::chrono::steady_clock::time_point now) -> void {
    ++m_frames;
    m_record += cost.record;
    m_submit += cost.submit;
    m_draw_calls += cost.renderer.draw_calls;
    m_passes += cost.renderer.passes;
    if (cost.renderer.gpu_time) {
        m_gpu += *cost.renderer.gpu_time;
        ++m_timed_frames;
    }
    if (now - m_window_start < window) {
        return;
    }
    kit::dev::send_text(
        std::format(
            "overlay: {} frames; per frame record {:.3f} ms, submit {:.3f} ms, gpu {:.3f} ms, "
            "{:.1f} "
            "draws, {:.1f} passes; {} atlas evictions, {} stale image misses so far",
            m_frames,
            milliseconds(m_record, m_frames),
            milliseconds(m_submit, m_frames),
            milliseconds(m_gpu, m_timed_frames),
            static_cast<f64>(m_draw_calls) / static_cast<f64>(m_frames),
            static_cast<f64>(m_passes) / static_cast<f64>(m_frames),
            cost.evictions,
            cost.renderer.stale_image_misses
        )
    );
    *this = dev_stats{now};
}

}
