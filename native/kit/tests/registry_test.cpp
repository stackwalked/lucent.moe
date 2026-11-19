#include <lucent/kit/registry.hpp>

#include <algorithm>
#include <atomic>
#include <optional>
#include <span>
#include <thread>
#include <tuple>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/canvas.hpp>
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

constexpr input_key aim_key{0x06};
constexpr input_key other_key{0x41};

auto down(input_key key) -> key_change {
    return key_change{.key = key, .is_down = true};
}

auto up(input_key key) -> key_change {
    return key_change{.key = key, .is_down = false};
}

// One tick of the overlay's order: keys, safe point, dispatch. Whether the tracker ran in it.
auto ran_with(registry& features, std::vector<key_change> changes) -> bool {
    std::vector<fixtures::sighting> log;
    features.feed({.changes = std::move(changes)});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    return !log.empty();
}

auto tracker_on_with(registry& features, bind_slot bind) -> void {
    features.request({
        enable_feature{.feature = tracker},
        change_bind{.feature = tracker, .bind = bind},
    });
    features.safe_point();
}

auto module_build(u64 name, u32 stamp) -> bundle::module_key {
    return bundle::module_key{.name_hash = name, .time_date_stamp = stamp, .size_of_image = 0x1000};
}

}

TEST_CASE("wiring records the one feature that owns each exclusive stage") {
    wiring wired;
    wired.add<fixtures::tracker>();
    CHECK_FALSE(wired.owner_of<fixtures::steering_stage>().has_value());

    wired.add<fixtures::steerer>();

    CHECK(wired.owner_of<fixtures::steering_stage>() == fixtures::steerer::id);
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

TEST_CASE("a snapshot pairs each feature's settings with their descriptions, in describe() order") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request({change_setting{.feature = tracker, .setting = scale, .value = 3.0F}});
    features.safe_point();

    const feature_snapshot tracked = snapshot_of(features, tracker);
    REQUIRE(tracked.descriptions.size() == tracked.settings.size());
    CHECK(tracked.descriptions.data() == descriptions_of<fixtures::tracker_settings>.data());
    const auto scale_at = std::ranges::find(tracked.descriptions, scale, &setting_description::id);
    REQUIRE(scale_at != tracked.descriptions.end());
    CHECK(
        tracked.settings.at(narrow<usize>(scale_at - tracked.descriptions.begin()))
        == setting_value{3.0F}
    );
    CHECK(snapshot_of(features, listener).descriptions.empty());
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

TEST_CASE(
    "a feature that only draws runs at the draw, never at the tick, and a fault there fails it"
) {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    wiring wired;
    wired.add<fixtures::painter>();
    registry features{std::move(wired), everything(), time};
    features.request({enable_feature{.feature = fixtures::painter::id}});
    features.safe_point();
    std::vector<fixtures::sighting> log;
    draw::draw_list list;
    canvas onto{list, {.x = 100.0F, .y = 100.0F}};

    run_tick(features, tick_with(log, 2));
    CHECK(onto.labels().empty());
    CHECK(features.stats(fixtures::painter::id).value_or(feature_stats{}).runs == 0);

    const fixtures::radar_view radar = tick_with(log, 2);
    view_set parts;
    parts.put(radar);
    features.draw(parts, onto);
    CHECK(onto.labels().size() == 2);
    CHECK(features.stats(fixtures::painter::id).value_or(feature_stats{}).runs == 1);

    const fixtures::radar_view broken = tick_with(log, -1);
    view_set broken_parts;
    broken_parts.put(broken);
    features.draw(broken_parts, onto);
    CHECK(features.state(fixtures::painter::id) == feature_state::failed);
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
        // Writing starts once the reader has read, so a busy machine that schedules it late can't
        // leave the test with nothing seen.
        while (seen.load(std::memory_order_relaxed) == 0) {
            std::this_thread::yield();
        }
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

TEST_CASE("an always bind runs an on feature whatever the keys do") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    tracker_on_with(features, {.mode = bind_mode::always, .key = aim_key});

    CHECK(ran_with(features, {}));
    CHECK(ran_with(features, {down(aim_key)}));
    CHECK(ran_with(features, {up(aim_key)}));
}

TEST_CASE("a hold bind runs the feature only in ticks its key is down at") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    tracker_on_with(features, {.mode = bind_mode::hold, .key = aim_key});

    CHECK_FALSE(ran_with(features, {}));
    CHECK(ran_with(features, {down(aim_key)}));
    // The keyboard's repeat changes nothing.
    CHECK(ran_with(features, {down(aim_key), down(aim_key)}));
    CHECK(ran_with(features, {down(other_key)}));
    CHECK_FALSE(ran_with(features, {up(aim_key)}));
    // Pressed and released between two ticks: down at neither.
    CHECK_FALSE(ran_with(features, {down(aim_key), up(aim_key)}));
    CHECK(snapshot_of(features, tracker).state == feature_state::on);
}

TEST_CASE("a toggle bind flips on each press, not on repeats or releases") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    tracker_on_with(features, {.mode = bind_mode::toggle, .key = aim_key});

    CHECK_FALSE(ran_with(features, {}));
    CHECK(ran_with(features, {down(aim_key)}));
    CHECK(ran_with(features, {down(aim_key), up(aim_key)}));
    CHECK(snapshot_of(features, tracker).is_active);
    CHECK_FALSE(ran_with(features, {down(aim_key)}));
    CHECK_FALSE(snapshot_of(features, tracker).is_active);
    // Two presses between ticks cancel out.
    CHECK_FALSE(ran_with(features, {up(aim_key), down(aim_key), up(aim_key), down(aim_key)}));
}

TEST_CASE("a hold or toggle bind without a key never runs the feature") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    tracker_on_with(features, {.mode = bind_mode::hold, .key = std::nullopt});
    CHECK_FALSE(ran_with(features, {down(aim_key)}));
    tracker_on_with(features, {.mode = bind_mode::toggle, .key = std::nullopt});
    CHECK_FALSE(ran_with(features, {down(other_key)}));
}

TEST_CASE("a bind never turns a feature on, and presses while it is off are no toggles") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request(
        {change_bind{.feature = tracker, .bind = {.mode = bind_mode::toggle, .key = aim_key}}}
    );
    features.safe_point();

    CHECK_FALSE(ran_with(features, {down(aim_key), up(aim_key)}));
    CHECK(features.state(tracker) == feature_state::off);
    CHECK_FALSE(snapshot_of(features, tracker).is_active);

    features.request({enable_feature{.feature = tracker}});
    CHECK_FALSE(ran_with(features, {}));
    CHECK(ran_with(features, {down(aim_key)}));
}

TEST_CASE("turning a feature off or giving it a new bind leaves its toggle inactive") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    tracker_on_with(features, {.mode = bind_mode::toggle, .key = aim_key});
    REQUIRE(ran_with(features, {down(aim_key), up(aim_key)}));

    features.request({disable_feature{.feature = tracker}});
    features.safe_point();
    features.request({enable_feature{.feature = tracker}});
    CHECK_FALSE(ran_with(features, {}));

    REQUIRE(ran_with(features, {down(aim_key), up(aim_key)}));
    features.request(
        {change_bind{.feature = tracker, .bind = {.mode = bind_mode::toggle, .key = other_key}}}
    );
    CHECK_FALSE(ran_with(features, {}));
}

TEST_CASE("a lapse stops every on feature at the next safe point, and a resume runs it as it was") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    REQUIRE(log.size() == 1);

    features.request({lapse_lease{}});
    run_tick(features, tick_with(log, 1));
    CHECK(log.size() == 2);
    features.safe_point();
    CHECK(features.state(tracker) == feature_state::lapsed);
    CHECK(features.state(listener) == feature_state::off);
    CHECK(snapshot_of(features, tracker).state == feature_state::lapsed);
    run_tick(features, tick_with(log, 1));
    CHECK(log.size() == 2);

    features.request({resume_lease{}});
    features.safe_point();
    run_tick(features, tick_with(log, 1));
    CHECK(features.state(tracker) == feature_state::on);
    REQUIRE(log.size() == 3);
    // Its own state outlasted the lapse: no restart.
    CHECK(log.back().ticks == 3);
}

TEST_CASE("during a lapse a person's choices stand and take effect on resume") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    features.request({enable_feature{.feature = tracker}});
    features.request({lapse_lease{}});
    features.safe_point();

    features.request({enable_feature{.feature = listener}});
    features.request({disable_feature{.feature = tracker}});
    features.safe_point();
    CHECK(features.state(listener) == feature_state::lapsed);
    CHECK(features.state(tracker) == feature_state::off);

    features.request({resume_lease{}});
    features.safe_point();
    CHECK(features.state(listener) == feature_state::on);
    CHECK(features.state(tracker) == feature_state::off);
}

TEST_CASE("a failed feature stays failed through a lapse and a resume") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;
    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, -1));
    REQUIRE(features.state(tracker) == feature_state::failed);

    features.request({lapse_lease{}});
    features.safe_point();
    CHECK(features.state(tracker) == feature_state::failed);
    features.request({resume_lease{}});
    features.safe_point();
    CHECK(features.state(tracker) == feature_state::failed);
}

TEST_CASE("a failure records the module builds current at it, until a person resets it") {
    resolve_capabilities(sound_fact::resolved);
    const test_clock time;
    registry features{both_features(), everything(), time};
    std::vector<fixtures::sighting> log;
    const std::vector<bundle::module_key> failed_on{module_build(7, 100), module_build(9, 200)};
    features.request({enable_feature{.feature = tracker}});
    features.request({replace_module_builds{.builds = failed_on}});
    features.safe_point();
    CHECK_FALSE(snapshot_of(features, tracker).failure.has_value());

    run_tick(features, tick_with(log, -1));
    // A game update after the failure doesn't rewrite what it failed on.
    features.request({replace_module_builds{.builds = {module_build(7, 101)}}});
    features.safe_point();
    CHECK(snapshot_of(features, tracker).failure == feature_failure{.builds = failed_on});

    features.request({reset_feature{.feature = tracker}});
    features.safe_point();
    CHECK(features.state(tracker) == feature_state::off);
    CHECK_FALSE(snapshot_of(features, tracker).failure.has_value());

    features.request({enable_feature{.feature = tracker}});
    features.safe_point();
    run_tick(features, tick_with(log, -1));
    features.safe_point();
    CHECK(
        snapshot_of(features, tracker).failure == feature_failure{.builds = {module_build(7, 101)}}
    );
}

}
