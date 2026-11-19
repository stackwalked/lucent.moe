#pragma once

#include <atomic>
#include <chrono>

namespace lucent::kit {

// Monotonic time, handed to whatever measures it so tests can step it. Only differences between
// readings mean anything. Read from any thread.
class clock {
public:
    using time_point = std::chrono::steady_clock::time_point;

    clock(const clock&) = delete ("a clock is passed by reference");
    auto operator=(const clock&) -> clock& = delete ("a clock is passed by reference");
    clock(clock&&) = delete ("a clock is passed by reference");
    auto operator=(clock&&) -> clock& = delete ("a clock is passed by reference");
    virtual ~clock();

    virtual auto now() const -> time_point = 0;

protected:
    clock() = default;
};

// The real clock: std::chrono::steady_clock, which never goes back and ignores changes to the
// system time.
class monotonic_clock final : public clock {
public:
    monotonic_clock() = default;

    auto now() const -> time_point override;
};

// Stands still until a test advances it. Starts at the epoch.
class test_clock final : public clock {
public:
    test_clock() = default;

    auto now() const -> time_point override;

    // Any thread; a reader on another thread sees the step once this returns.
    auto advance(std::chrono::nanoseconds step) -> void;

private:
    // Nanoseconds since the epoch.
    std::atomic<i64> m_elapsed{0};
};

}
