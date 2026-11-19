#include <lucent/kit/context.hpp>

#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/feature.hpp>
#include <lucent/kit/view_set.hpp>

#include "feature_fixtures.hpp"

// A feature reaching a part it didn't declare would run where that part's capability is missing:
// the context refuses it at compile time. tests/context_undeclared.cpp shows the refusal as a
// build that fails.

namespace lucent::kit {
namespace {

template <typename F, typename Part>
concept can_view = requires(const context<F>& parts) { parts.template view<Part>(); };

template <typename F, typename Part>
concept can_maybe = requires(const context<F>& parts) { parts.template maybe<Part>(); };

static_assert(can_view<fixtures::tracker, fixtures::radar_view>);
static_assert(!can_view<fixtures::tracker, fixtures::sound_view>);
static_assert(!can_view<fixtures::tracker, fixtures::clock_view>);
static_assert(can_maybe<fixtures::tracker, fixtures::sound_view>);
static_assert(!can_maybe<fixtures::tracker, fixtures::radar_view>);
static_assert(!can_maybe<fixtures::tracker, fixtures::clock_view>);

static_assert(feature_id_of<"tracker"> != feature_id_of<"listener">);

// Parts are told apart by type alone, templates included.
template <typename T>
struct wrapped {};

static_assert(detail::type_key<fixtures::radar_view>() != detail::type_key<fixtures::sound_view>());
static_assert(detail::type_key<wrapped<i32>>() != detail::type_key<wrapped<u32>>());

}

TEST_CASE("a wanted part the domain didn't build reaches the feature as null") {
    std::vector<fixtures::sighting> log;
    const fixtures::radar_view radar{.blips = 2, .log = &log};
    view_set parts;
    parts.put(radar);
    const fixtures::tracker_settings current;
    const context<fixtures::tracker> given{parts, current};

    CHECK(&given.view<fixtures::radar_view>() == &radar);
    CHECK(given.maybe<fixtures::sound_view>() == nullptr);
}

TEST_CASE("a feature's needs are met only when every needed part was built") {
    std::vector<fixtures::sighting> log;
    const fixtures::radar_view radar{.blips = 2, .log = &log};
    const fixtures::sound_view sound{.steps = 1};
    view_set without_radar;
    without_radar.put(sound);
    view_set with_radar;
    with_radar.put(radar);

    CHECK_FALSE(has_needs<fixtures::tracker>(without_radar));
    CHECK(has_needs<fixtures::tracker>(with_radar));
}

}
