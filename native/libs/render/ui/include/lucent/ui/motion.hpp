#pragma once

#include <algorithm>
#include <chrono>

namespace lucent::ui {

// A frame's step is clamped to this, so a hitch or a paused game doesn't throw motion to its end in
// one jump that reads as a glitch.
inline constexpr std::chrono::milliseconds max_frame_step{100};

// A spring integrates in steps of this, whatever the frame rate, so it moves the same at 30 and 240
// frames a second.
inline constexpr std::chrono::nanoseconds spring_substep{4'166'667};

enum class easing : u8 {
    linear,
    out_cubic,
    in_out_cubic,
};

// Progress through a tween, 0 to 1, to how far the value has moved, 0 to 1.
constexpr auto eased(easing curve, f32 progress) -> f32 {
    const f32 done = std::clamp(progress, 0.0F, 1.0F);
    switch (curve) {
    case easing::linear:
        return done;
    case easing::out_cubic: {
        const f32 rest = 1.0F - done;
        return 1.0F - (rest * rest * rest);
    }
    case easing::in_out_cubic: {
        if (done < 0.5F) {
            return 4.0F * done * done * done;
        }
        const f32 rest = (-2.0F * done) + 2.0F;
        return 1.0F - (rest * rest * rest / 2.0F);
    }
    }
    LUCENT_UNREACHABLE();
}

// One step of motion toward target. timing is the primitive's own measure (a half-life, a spring's
// response); zero snaps to the target, which is how reduced motion stops everything.
struct motion_step {
    f32 target = 0.0F;
    std::chrono::nanoseconds timing{};
    std::chrono::nanoseconds elapsed{};
};

// Exponential: the distance to target halves every timing.
auto approached(f32 current, const motion_step& step) -> f32;

struct spring_value {
    f32 position = 0.0F;
    f32 velocity = 0.0F;
    // Time not yet integrated: less than one substep.
    std::chrono::nanoseconds pending{};

    auto operator==(const spring_value&) const -> bool = default;
};

// Critically damped, with timing as its response (the period it would ring at undamped). Keeps its
// velocity when the target moves, so a retarget mid-flight bends rather than restarts.
auto sprung(spring_value current, const motion_step& step) -> spring_value;

}
