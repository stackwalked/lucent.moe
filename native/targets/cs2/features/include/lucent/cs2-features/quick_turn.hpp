#pragma once

#include <array>

#include <lucent/cs2-domains/view_state.hpp>
#include <lucent/cs2-domains/view_turns.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::cs2::features {

struct quick_turn_settings {
    // Counterclockwise positive, as the game's yaw.
    f32 degrees = 180.0F;

    static constexpr auto describe() -> std::array<kit::setting<quick_turn_settings>, 1> {
        return {
            kit::number<"quick_turn/degrees", &quick_turn_settings::degrees>(
                {.min = -180.0F, .max = 180.0F, .step = 5.0F}
            ),
        };
    }
};

// Turns the view around once each time its bind starts it running: the turn goes to the view,
// which spreads it over as many commands as a real mouse would need.
class quick_turn final {
public:
    static constexpr kit::feature_id id = kit::feature_id_of<"quick_turn">;
    static constexpr kit::feature_tag tag{"movement"};
    using needs = kit::needs<view_state, view_turns>;
    using wants = kit::wants<>;
    using settings = quick_turn_settings;

    auto tick(const kit::context<quick_turn>& parts) -> void;

private:
    // The command tick it last ran at: a gap means its bind started it again.
    i64 m_ran_at = -1;
};

}
