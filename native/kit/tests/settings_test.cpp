#include <lucent/kit/settings.hpp>

#include <algorithm>
#include <array>
#include <limits>

#include "feature_fixtures.hpp"

// Config, the menu and scripts will trust describe() to say what a value may be: a wrong range,
// kind or default there would store or show values the feature never expects.

namespace lucent::kit {
namespace {

constexpr auto described = descriptions_of<fixtures::tracker_settings>;

static_assert(described.size() == 4);
static_assert(described[0].id == setting_key("tracker/loud"));
static_assert(described[0].kind == setting_kind::toggle);
static_assert(described[0].initial == setting_value{false});
static_assert(described[1].kind == setting_kind::number);
static_assert(described[1].initial == setting_value{1.0F});
static_assert(described[2].kind == setting_kind::choice);
static_assert(
    std::ranges::equal(described[2].options, std::array{setting_key("dot"), setting_key("ring")})
);
static_assert(described[2].initial == setting_value{isize{0}});
static_assert(described[3].kind == setting_kind::color);
static_assert(described[3].initial == setting_value{color{.r = 255, .g = 0, .b = 0, .a = 255}});

// A value is accepted only in its own kind, inside its range, naming an option that exists.
static_assert(is_valid(described[1], setting_value{0.5F}));
static_assert(is_valid(described[1], setting_value{4.0F}));
static_assert(!is_valid(described[1], setting_value{0.25F}));
static_assert(!is_valid(described[1], setting_value{4.5F}));
static_assert(!is_valid(described[1], setting_value{std::numeric_limits<f32>::quiet_NaN()}));
static_assert(!is_valid(described[1], setting_value{true}));
static_assert(is_valid(described[2], setting_value{isize{1}}));
static_assert(!is_valid(described[2], setting_value{isize{2}}));
static_assert(!is_valid(described[2], setting_value{isize{-1}}));
static_assert(!is_valid(described[0], setting_value{1.0F}));

// Values move in and out of the members describe() names.
constexpr auto round_trip = [] {
    fixtures::tracker_settings changed;
    settings_of<fixtures::tracker_settings>[2].write(changed, setting_value{isize{1}});
    settings_of<fixtures::tracker_settings>[1].write(changed, setting_value{2.5F});
    return changed;
}();
static_assert(round_trip.shape == fixtures::marker::ring);
static_assert(settings_of<fixtures::tracker_settings>[1].read(round_trip) == setting_value{2.5F});
static_assert(
    settings_of<fixtures::tracker_settings>[2].read(round_trip) == setting_value{isize{1}}
);

static_assert(is_well_described<fixtures::tracker_settings>());
static_assert(is_well_described<no_settings>());

// Two settings on one path, and a default outside its own range, are refused where the feature is
// wired.
struct twice_named {
    bool first = false;
    bool second = false;

    static constexpr auto describe() -> std::array<setting<twice_named>, 2> {
        return {
            toggle<"same", &twice_named::first>(),
            toggle<"same", &twice_named::second>(),
        };
    }
};

struct out_of_range {
    f32 scale = 9.0F;

    static constexpr auto describe() -> std::array<setting<out_of_range>, 1> {
        return {number<"scale", &out_of_range::scale>({.min = 0.0F, .max = 1.0F, .step = 0.1F})};
    }
};

static_assert(!is_well_described<twice_named>());
static_assert(!is_well_described<out_of_range>());

}
}
