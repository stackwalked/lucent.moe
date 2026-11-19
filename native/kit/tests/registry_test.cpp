#include <lucent/kit/registry.hpp>

#include <algorithm>
#include <atomic>
#include <optional>
#include <span>
#include <thread>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <lucent/kit/clock.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/kit/wiring.hpp>

#include "feature_fixtures.hpp"
#include "lucent/kit/published.hpp"

// The registry's state machine decides what runs in the game: a transition that went wrong would
// run a feature the member turned off or isn't entitled to, or bring a faulted one back silently.

namespace lucent::kit {
namespace {

constexpr feature_id tracker = fixtures::tracker::id;
constexpr feature_id listener = fixtures::listener::id;
constexpr setting_id scale = setting_key("tracker/scale");
constexpr setting_id loud = setting_key("tracker/loud");

enum class sound_fact : u8 { resolved, unresolved };

// Resolves radar's fact, and sound's when asked; every other fact in the image is reset.
auto resolve_capabilities(sound_fact sound) -> void {
    std::vector<fact_value> values{
        fact_value{.key = fixtures::radar_range.record().key, .value = 50},
    };
    if (sound == sound_fact::resolved) {
        values.push_back(fact_value{.key = fixtures::sound_range.record().key, .value = 50});
    }
    std::ignore = resolve(linked_fact_records(), values, {});
}

auto both_features() -> wiring {
    wiring wired;
    wired.add<fixtures::tracker>();
    wired.add<fixtures::listener>();
    return wired;
}

auto everything() -> entitlements {
    return entitlements{.is_everything = true, .features = {}};
}

auto tick_with(std::vector<fixtures::sighting>& log, i32 blips) -> fixtures::radar_view {
    return fixtures::radar_view{.blips = blips, .log = &log};
}

auto run_tick(registry& features, const fixtures::radar_view& radar) -> void {
    view_set parts;
    parts.put(radar);
    features.dispatch(parts);
}

// Any thread: no Catch assertion inside.
auto published_snapshot(registry& features, feature_id feature) -> std::optional<feature_snapshot> {
    const published<registry_snapshot>::reading seen = features.read();
    const auto found = std::ranges::find(seen->features, feature, &feature_snapshot::id);
    return found == seen->features.end() ? std::nullopt : std::optional{*found};
}

auto snapshot_of(registry& features, feature_id feature) -> feature_snapshot {
    std::optional<feature_snapshot> found = published_snapshot(features, feature);
    if (!found) {
        FAIL("the feature isn't in the published snapshot");
        return {};
    }
    return *found;
}

}

TEST_CASE("a wired feature starts off and turns on and off only at a safe point") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;

    CHECK(features.state(tracker) == feature_state::off);
    features.request({enable_feature{.feature = tracker}});
    CHECK(features.state(tracker) == feature_state::off);
    run_tick(features, tick_with(log, 1));
    CHECK(log.empty());

    features.safe_point();
    CHECK(features.state(tracker) == feature_state::on);
    run_tick(features, tick_with(log, 1));
    CHECK(log.size() == 1);

    features.request({disable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    CHECK(features.state(tracker) == feature_state::off);
    CHECK(log.size() == 1);
}

TEST_CASE("a feature is unavailable while a needed capability is, until a safe point sees it") {
    resolve_capabilities(sound_fact::unresolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request({enable_feature{.feature = listener}});
    features.safe_point();

    CHECK(features.state(listener) == feature_state::unavailable);
    CHECK(snapshot_of(features, listener).state == feature_state::unavailable);

    // A late module's facts resolving.
    resolve_capabilities(sound_fact::resolved);
    CHECK(features.state(listener) == feature_state::unavailable);
    features.safe_point();

    CHECK(features.state(listener) == feature_state::on);
    CHECK(snapshot_of(features, listener).state == feature_state::on);
}

TEST_CASE("an unentitled feature never runs, and runs as chosen once entitled") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), entitlements{.is_everything = false, .features = {}}, time};
    std::vector<fixtures::sighting> log;
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();

    run_tick(features, tick_with(log, 1));
    CHECK(features.state(tracker) == feature_state::unentitled);
    CHECK(log.empty());

    features.request(
        {replace_entitlements{.entitled = {.is_everything = false, .features = {tracker}}}}
    );
    features.safe_point();
    run_tick(features, tick_with(log, 1));

    CHECK(features.state(tracker) == feature_state::on);
    CHECK(features.state(listener) == feature_state::unentitled);
    CHECK(log.size() == 1);
}

TEST_CASE("a fault fails the feature, which stays failed until a person resets it") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    REQUIRE(log.size() == 1);

    run_tick(features, tick_with(log, -1));
    CHECK(features.state(tracker) == feature_state::failed);
    CHECK(features.stats(tracker).value_or(feature_stats{}).faults == 1);
    // Readers learn of it at the next safe point.
    CHECK(snapshot_of(features, tracker).state == feature_state::on);
    features.safe_point();
    CHECK(snapshot_of(features, tracker).state == feature_state::failed);

    features.request({disable_feature{.feature = tracker}});
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    CHECK(features.state(tracker) == feature_state::failed);
    CHECK(log.size() == 1);

    features.request({reset_feature{.feature = tracker}});
    features.safe_point();
    CHECK(features.state(tracker) == feature_state::off);
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));

    REQUIRE(log.size() == 2);
    // A fresh feature: its own state started over.
    CHECK(log.back().ticks == 1);
}

TEST_CASE("a tick without a needed part skips the feature without failing it") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();

    features.dispatch(view_set{});

    CHECK(features.state(tracker) == feature_state::on);
    CHECK(features.stats(tracker).value_or(feature_stats{}).skips == 1);
    CHECK(features.stats(tracker).value_or(feature_stats{}).runs == 0);
}

TEST_CASE("a setting changes between ticks only, at the safe point") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();

    features.request(
        {change_setting{.feature = tracker, .setting = scale, .value = setting_value{2.0F}}}
    );
    run_tick(features, tick_with(log, 1));
    features.safe_point();
    run_tick(features, tick_with(log, 1));

    REQUIRE(log.size() == 2);
    CHECK_THAT(log.front().scale, Catch::Matchers::WithinULP(1.0F, 0));
    CHECK_THAT(log.back().scale, Catch::Matchers::WithinULP(2.0F, 0));
    CHECK(snapshot_of(features, tracker).settings.at(1) == setting_value{2.0F});
}

TEST_CASE("a batch with one change the registry refuses applies none of its changes") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request({
        enable_feature{.feature = tracker},
        change_setting{.feature = tracker, .setting = scale, .value = setting_value{9.0F}},
    });
    features.request({enable_feature{.feature = feature_id_of<"never wired">}});
    features.safe_point();

    CHECK(features.state(tracker) == feature_state::off);
    CHECK(snapshot_of(features, tracker).settings.at(1) == setting_value{1.0F});
}

TEST_CASE("readers on another thread see each batch whole or not at all") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::atomic<bool> is_done{false};
    std::atomic<i32> torn{0};
    std::atomic<i32> seen{0};
    {
        const std::jthread reader{[&] {
            while (!is_done.load(std::memory_order_acquire)) {
                const std::optional<feature_snapshot> found = published_snapshot(features, tracker);
                if (!found) {
                    torn.fetch_add(1, std::memory_order_relaxed);
                    continue;
                }
                const feature_snapshot& tracked = *found;
                const bool is_on = tracked.state == feature_state::on;
                const bool is_scaled = tracked.settings.at(1) == setting_value{2.0F};
                const bool is_loud = tracked.settings.at(0) == setting_value{true};
                if (is_on != is_scaled || is_on != is_loud) {
                    torn.fetch_add(1, std::memory_order_relaxed);
                }
                seen.fetch_add(1, std::memory_order_relaxed);
            }
        }};
        for (isize round = 0; round < 5000; ++round) {
            const bool is_on = round % 2 == 0;
            features.request({
                is_on ? registry_change{enable_feature{.feature = tracker}}
                      : registry_change{disable_feature{.feature = tracker}},
                change_setting{
                    .feature = tracker,
                    .setting = scale,
                    .value = setting_value{is_on ? 2.0F : 1.0F},
                },
                change_setting{.feature = tracker, .setting = loud, .value = setting_value{is_on}},
            });
            features.safe_point();
        }
        is_done.store(true, std::memory_order_release);
    }

    CHECK(torn.load(std::memory_order_relaxed) == 0);
    CHECK(seen.load(std::memory_order_relaxed) > 0);
}

}
