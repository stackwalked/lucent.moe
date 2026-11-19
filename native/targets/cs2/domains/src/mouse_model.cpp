#include <lucent/cs2-domains/mouse_model.hpp>

#include <algorithm>
#include <cmath>
#include <optional>
#include <utility>

namespace lucent::cs2 {
namespace {

// What is wanted on an axis, what one count turns it by, and the counts already owed on it.
struct axis_ask {
    f32 wanted = 0.0F;
    f32 size = 0.0F;
    i32 owed = 0;
};

// The whole counts of what is wanted on an axis, within what the next command still has room for.
auto counts_for(const axis_ask& ask) -> i32 {
    if (ask.size == 0.0F || !std::isfinite(ask.size) || !std::isfinite(ask.wanted)) {
        return 0;
    }
    const f32 counts = std::round(ask.wanted / ask.size);
    const auto lowest = static_cast<f32>(-counts_per_command - ask.owed);
    const auto highest = static_cast<f32>(counts_per_command - ask.owed);
    return static_cast<i32>(std::clamp(counts, std::min(lowest, 0.0F), std::max(highest, 0.0F)));
}

// The most pitch counts that keep the view inside the limits.
auto pitch_within_limits(i32 counts, heading now, count_size size) -> i32 {
    i32 kept = counts;
    while (kept != 0 && std::abs(now.pitch + (static_cast<f32>(kept) * size.pitch)) > pitch_limit) {
        kept += kept > 0 ? -1 : 1;
    }
    return kept;
}

// Yaw back into -180..180.
auto wrapped(f32 yaw) -> f32 {
    return std::remainder(yaw, 360.0F);
}

}

auto mouse_model::request(view_turn wanted) -> void {
    m_pending.pitch += wanted.pitch;
    m_pending.yaw += wanted.yaw;
}

auto mouse_model::turn(heading now, count_size size) -> std::optional<heading> {
    const i32 moved_x = counts_for({.wanted = m_pending.yaw, .size = size.yaw, .owed = m_owed.dx});
    const i32 moved_y = pitch_within_limits(
        counts_for({.wanted = m_pending.pitch, .size = size.pitch, .owed = m_owed.dy}), now, size
    );
    if (moved_x == 0 && moved_y == 0) {
        return std::nullopt;
    }
    const f32 yaw_turned = static_cast<f32>(moved_x) * size.yaw;
    const f32 pitch_turned = static_cast<f32>(moved_y) * size.pitch;
    m_pending.yaw -= yaw_turned;
    m_pending.pitch -= pitch_turned;
    m_owed.dx += moved_x;
    m_owed.dy += moved_y;
    return heading{.pitch = now.pitch + pitch_turned, .yaw = wrapped(now.yaw + yaw_turned)};
}

auto mouse_model::settle() -> mouse_counts {
    return std::exchange(m_owed, mouse_counts{});
}

auto mouse_model::forget() -> void {
    m_pending = {};
    m_owed = {};
}

auto mouse_model::pending() const -> view_turn {
    return m_pending;
}

auto mouse_model::owed() const -> mouse_counts {
    return m_owed;
}

}
