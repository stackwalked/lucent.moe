#include <lucent/cs2-features/quick_turn.hpp>

#include <utility>

#include <lucent/cs2-domains/view_state.hpp>
#include <lucent/cs2-domains/view_turns.hpp>
#include <lucent/kit/context.hpp>

namespace lucent::cs2::features {

auto quick_turn::tick(const kit::context<quick_turn>& parts) -> void {
    const auto& view = parts.view<view_state>();
    const i64 last = std::exchange(m_ran_at, view.tick);
    if (last == view.tick - 1) {
        return;
    }
    parts.view<view_turns>().turn({.pitch = 0.0F, .yaw = parts.settings().degrees});
}

}
