#include <lucent/kit/clock.hpp>

#include <atomic>
#include <chrono>

namespace lucent::kit {

// Out of line, so the vtable has one home.
clock::~clock() = default;

auto monotonic_clock::now() const -> time_point {
    return std::chrono::steady_clock::now();
}

auto test_clock::now() const -> time_point {
    return time_point{std::chrono::nanoseconds{m_elapsed.load(std::memory_order_acquire)}};
}

auto test_clock::advance(std::chrono::nanoseconds step) -> void {
    // Backwards would break the one promise a clock makes.
    LUCENT_INVARIANT(step.count() >= 0);
    m_elapsed.fetch_add(step.count(), std::memory_order_acq_rel);
}

}
