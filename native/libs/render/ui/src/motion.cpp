#include <lucent/ui/motion.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <numbers>

namespace lucent::ui {
namespace {

auto seconds(std::chrono::nanoseconds span) -> f32 {
    return std::chrono::duration<f32>{span}.count();
}

}

auto approached(f32 current, const motion_step& step) -> f32 {
    if (step.timing <= std::chrono::nanoseconds{0}) {
        return step.target;
    }
    const f32 halvings = seconds(step.elapsed) / seconds(step.timing);
    return step.target + ((current - step.target) * std::exp2(-halvings));
}

auto sprung(spring_value current, const motion_step& step) -> spring_value {
    if (step.timing <= std::chrono::nanoseconds{0}) {
        return {.position = step.target, .velocity = 0.0F, .pending = {}};
    }
    const f32 frequency = 2.0F * std::numbers::pi_v<f32> / seconds(step.timing);
    const f32 substep = seconds(spring_substep);
    spring_value next = current;
    // However long the caller waited, the spring never integrates more than a frame's worth.
    next.pending += std::clamp<std::chrono::nanoseconds>(
        step.elapsed, std::chrono::nanoseconds{0}, max_frame_step
    );
    while (next.pending >= spring_substep) {
        const f32 acceleration = (frequency * frequency * (step.target - next.position))
                                 - (2.0F * frequency * next.velocity);
        next.velocity += acceleration * substep;
        next.position += next.velocity * substep;
        next.pending -= spring_substep;
    }
    return next;
}

}
