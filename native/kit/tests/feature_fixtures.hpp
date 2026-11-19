#pragma once

#include <array>
#include <vector>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

// Features, the parts they use and the facts behind those parts, standing in for a domain and a
// real feature. A test resolves the facts it wants available and leaves the rest unresolved.

namespace lucent::kit::fixtures {

LUCENT_FACT fact::value<i32> radar_range{"fixture_radar_range", 1, {.min = 0, .max = 100}};
LUCENT_FACT fact::value<i32> sound_range{"fixture_sound_range", 1, {.min = 0, .max = 100}};
LUCENT_FACT fact::value<i32> clock_rate{"fixture_clock_rate", 1, {.min = 0, .max = 100}};

using radar = capability<radar_range>;
using sound = capability<sound_range>;
using timing = capability<clock_rate>;

// What a tick saw, written back through the part that carried it in.
struct sighting {
    i32 blips = 0;
    bool has_steps = false;
    f32 scale = 0.0F;
    bool is_loud = false;
    i32 ticks = 0;
};

// A test owns the log; the part only points at it.
struct radar_view {
    using backing = radar;

    i32 blips = 0;
    std::vector<sighting>* log = nullptr;
};

struct sound_view {
    using backing = sound;

    i32 steps = 0;
};

// Declared by no feature.
struct clock_view {
    using backing = timing;

    i32 rate = 0;
};

enum class marker : u8 { dot, ring };

struct tracker_settings {
    bool is_loud = false;
    f32 scale = 1.0F;
    marker shape = marker::dot;
    color tint{.r = 255, .g = 0, .b = 0, .a = 255};

    static constexpr auto describe() -> std::array<setting<tracker_settings>, 4> {
        return {
            toggle<"tracker/loud", &tracker_settings::is_loud>(),
            number<"tracker/scale", &tracker_settings::scale>(
                {.min = 0.5F, .max = 4.0F, .step = 0.5F}
            ),
            choice<"tracker/shape", &tracker_settings::shape, "dot", "ring">(),
            color_of<"tracker/tint", &tracker_settings::tint>(),
        };
    }
};

// Logs every tick; a radar showing negative blips surprises it into a fault.
class tracker {
public:
    static constexpr feature_id id = feature_id_of<"tracker">;
    using needs = kit::needs<radar_view>;
    using wants = kit::wants<sound_view>;
    using settings = tracker_settings;

    auto tick(const context<tracker>& parts) -> void {
        const auto& radar = parts.view<radar_view>();
        LUCENT_ENSURE(radar.blips >= 0);
        ++m_ticks;
        radar.log->push_back(
            sighting{
                .blips = radar.blips,
                .has_steps = parts.maybe<sound_view>() != nullptr,
                .scale = parts.settings().scale,
                .is_loud = parts.settings().is_loud,
                .ticks = m_ticks,
            }
        );
    }

private:
    i32 m_ticks = 0;
};

// Needs sound, so it is unavailable while sound's fact is unresolved.
class listener {
public:
    static constexpr feature_id id = feature_id_of<"listener">;
    using needs = kit::needs<sound_view>;
    using wants = kit::wants<>;
    using settings = no_settings;

    auto tick(const context<listener>& /*parts*/) -> void {}
};

}
