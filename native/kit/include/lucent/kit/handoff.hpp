#pragma once

#include <atomic>
#include <concepts>
#include <optional>
#include <utility>

namespace lucent::kit {

// One value made on one thread and taken, once, on another: a build on a kit worker handing its
// result back to the thread that asked for it. Neither side ever waits.
//
// The producer holds this object's address until it has given, so the owner drops it only once
// the value is taken, or once the producer is known to be done (its worker set stopped).
template <std::movable T>
class handoff final {
public:
    handoff() = default;
    handoff(const handoff&) = delete ("the producer holds its address");
    auto operator=(const handoff&) -> handoff& = delete ("the producer holds its address");
    handoff(handoff&&) = delete ("the producer holds its address");
    auto operator=(handoff&&) -> handoff& = delete ("the producer holds its address");
    ~handoff() = default;

    // The producing thread, once. After this it must not touch the object again.
    auto give(T value) -> void {
        // Relaxed: only this thread ever moves the stage on from empty.
        LUCENT_INVARIANT(m_stage.load(std::memory_order_relaxed) == stage::empty);
        m_value.emplace(std::move(value));
        m_stage.store(stage::given, std::memory_order_release);
    }

    // The taking thread: the value the first time it is asked for after give(), and empty before
    // that and ever after.
    auto take() -> std::optional<T> {
        stage expected = stage::given;
        // Acquire pairs with give()'s release, so the value is whole when it is moved out. Relaxed
        // on failure: nothing is read then.
        if (!m_stage.compare_exchange_strong(
                expected, stage::taken, std::memory_order_acquire, std::memory_order_relaxed
            )) {
            return std::nullopt;
        }
        return std::exchange(m_value, std::nullopt);
    }

private:
    enum class stage : u8 { empty, given, taken };

    std::optional<T> m_value;
    std::atomic<stage> m_stage{stage::empty};
};

}
