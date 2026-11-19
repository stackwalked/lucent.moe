#pragma once

#include <lucent/cs2-domains/command_input.hpp>
#include <lucent/cs2-domains/command_stages.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::cs2::features {

// While the player holds attack, the attack goes in as a press one tick and a release the next,
// so a semi-automatic weapon fires on every edge it can take instead of once per click.
class rapid_fire final {
public:
    static constexpr kit::feature_id id = kit::feature_id_of<"rapid_fire">;
    static constexpr kit::feature_tag tag{"aim"};
    using needs = kit::needs<command_input, aim_shot_stage>;
    using wants = kit::wants<>;
    using settings = kit::no_settings;

    auto tick(const kit::context<rapid_fire>& parts) -> void;

private:
    // The command tick it last pressed at; the next tick releases.
    i64 m_pressed_at = -1;
};

}
