#include <lucent/kit/config_store.hpp>

#include <algorithm>
#include <atomic>
#include <optional>
#include <thread>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/result.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/memory_storage.hpp>
#include <lucent/kit/profile.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/wiring.hpp>

#include "feature_fixtures.hpp"

// A profile switch that reached the game half applied, an undo that restored the wrong value, or a
// scope that leaked into another would all run a feature with settings nobody chose, and look
// right in the menu until someone noticed in a game.

namespace lucent::kit {
namespace {

constexpr feature_id tracker = fixtures::tracker::id;
constexpr setting_id loud = setting_key("tracker/loud");
constexpr setting_id scale = setting_key("tracker/scale");
constexpr setting_place loud_place{.feature = tracker, .setting = loud};
constexpr setting_place scale_place{.feature = tracker, .setting = scale};
constexpr scope_id rifle{11};
constexpr scope_id rifles{12};
constexpr scope_id pistols{13};
constexpr bind_slot held_bind{.mode = bind_mode::hold, .key = input_key{0x06}};

auto resolve_capabilities() -> void {
    std::ignore = resolve(
        linked_fact_records(),
        std::vector<fact_value>{
            fact_value{.key = fixtures::radar_range.record().key, .value = 50},
            fact_value{.key = fixtures::sound_range.record().key, .value = 50},
        },
        {}
    );
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

// Any thread: no Catch assertion inside.
auto published_tracker(registry& features) -> std::optional<feature_snapshot> {
    const published<registry_snapshot>::reading seen = features.read();
    const auto found = std::ranges::find(seen->features, tracker, &feature_snapshot::id);
    return found == seen->features.end() ? std::nullopt : std::optional{*found};
}

// The tracker's settings as the registry runs them, after a safe point.
struct running {
    setting_value is_loud;
    setting_value scale;
    bind_slot bind;

    auto operator==(const running&) const -> bool = default;
};

auto running_after_safe_point(registry& features) -> running {
    features.safe_point();
    const std::optional<feature_snapshot> found = published_tracker(features);
    if (!found) {
        FAIL("the tracker isn't in the published snapshot");
        return {};
    }
    return {.is_loud = found->settings.at(0), .scale = found->settings.at(1), .bind = found->bind};
}

auto set_scale(f32 value) -> change_setting {
    return change_setting{.feature = tracker, .setting = scale, .value = setting_value{value}};
}

auto make_loud() -> change_setting {
    return change_setting{.feature = tracker, .setting = loud, .value = setting_value{true}};
}

constexpr running defaults{
    .is_loud = setting_value{false},
    .scale = setting_value{1.0F},
    .bind = bind_slot{.mode = bind_mode::always, .key = std::nullopt},
};

constexpr running tuned_running{
    .is_loud = setting_value{true},
    .scale = setting_value{3.0F},
    .bind = held_bind,
};

// A second profile whose every tracker setting and bind differs from the defaults.
auto add_tuned(config_store& configs) -> profile_id {
    const profile_id was = configs.active();
    const profile_id tuned = configs.create("tuned");
    std::ignore = configs.switch_to(tuned);
    configs.edit(
        {set_scale(3.0F), make_loud(), change_bind{.feature = tracker, .bind = held_bind}}
    );
    std::ignore = configs.switch_to(was);
    return tuned;
}

auto is_tuned(const feature_snapshot& tracked) -> bool {
    return tracked.settings.size() == 4 && tracked.settings.at(1) == setting_value{3.0F};
}

// Torn: some of the tracker's settings from one profile and some from the other.
auto is_torn(const feature_snapshot& tracked) -> bool {
    const bool is_loud = tracked.settings.at(0) == setting_value{true};
    const bool is_held = tracked.bind == held_bind;
    return is_tuned(tracked) != is_loud || is_tuned(tracked) != is_held;
}

struct reads {
    std::atomic<i32> whole{0};
    std::atomic<i32> torn{0};
};

// Any thread: no Catch assertion inside.
auto read_until(registry& features, const std::atomic<bool>& is_done, reads& seen) -> void {
    while (!is_done.load(std::memory_order_acquire)) {
        const std::optional<feature_snapshot> found = published_tracker(features);
        if (!found || is_torn(*found)) {
            seen.torn.fetch_add(1, std::memory_order_relaxed);
            continue;
        }
        seen.whole.fetch_add(1, std::memory_order_relaxed);
    }
}

}

TEST_CASE("a store over empty storage makes one profile of every default, which it keeps") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    const config_store configs{features, kept, "first"};

    REQUIRE(configs.profiles().size() == 1);
    const profile& first = configs.profiles().front();
    CHECK(first.name == "first");
    CHECK(first.values.at(scale_place) == setting_value{1.0F});
    CHECK(first.binds.at(tracker) == bind_slot{});
    CHECK(kept.profiles() == std::vector<profile>{first});
    CHECK(running_after_safe_point(features) == defaults);
}

TEST_CASE("a profile switch moves nothing until the registry's next safe point") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "plain"};
    const profile_id plain = configs.active();
    const profile_id tuned = add_tuned(configs);
    REQUIRE(configs.switch_to(tuned).has_value());
    REQUIRE(running_after_safe_point(features) == tuned_running);

    REQUIRE(configs.switch_to(plain).has_value());
    CHECK(is_tuned(published_tracker(features).value_or(feature_snapshot{})));
    CHECK(running_after_safe_point(features) == defaults);
}

TEST_CASE("readers on another thread see a profile switch whole or not at all") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "plain"};
    const profile_id plain = configs.active();
    const profile_id tuned = add_tuned(configs);
    std::atomic<bool> is_done{false};
    reads seen;
    {
        const std::jthread reader{[&] { read_until(features, is_done, seen); }};
        // Switching starts once the reader has read, so a busy machine that schedules it late
        // can't leave the test with nothing seen.
        while (
            seen.whole.load(std::memory_order_relaxed) + seen.torn.load(std::memory_order_relaxed)
            == 0) {
            std::this_thread::yield();
        }
        for (isize round = 0; round < 3000; ++round) {
            std::ignore = configs.switch_to(round % 2 == 0 ? tuned : plain);
            features.safe_point();
        }
        is_done.store(true, std::memory_order_release);
    }

    CHECK(seen.torn.load(std::memory_order_relaxed) == 0);
    CHECK(seen.whole.load(std::memory_order_relaxed) > 0);
}

TEST_CASE("undo and redo step through a profile's edits, one batch to a step") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "only"};
    CHECK_FALSE(configs.has_undo());

    configs.edit({set_scale(2.0F)});
    configs.edit({set_scale(3.0F), make_loud(), set_scale(3.5F)});
    configs.edit({change_bind{.feature = tracker, .bind = held_bind}});
    CHECK(
        running_after_safe_point(features)
        == running{.is_loud = setting_value{true}, .scale = setting_value{3.5F}, .bind = held_bind}
    );

    configs.undo();
    configs.undo();
    CHECK(
        running_after_safe_point(features)
        == running{.is_loud = setting_value{false}, .scale = setting_value{2.0F}, .bind = {}}
    );
    CHECK(kept.profiles().front().values.at(scale_place) == setting_value{2.0F});

    configs.redo();
    CHECK(
        running_after_safe_point(features)
        == running{.is_loud = setting_value{true}, .scale = setting_value{3.5F}, .bind = {}}
    );
    CHECK(configs.has_redo());

    // A new edit forgets what could have been redone.
    configs.edit({set_scale(0.5F)});
    CHECK_FALSE(configs.has_redo());
    configs.redo();
    CHECK(running_after_safe_point(features).scale == setting_value{0.5F});

    configs.undo();
    configs.undo();
    configs.undo();
    CHECK_FALSE(configs.has_undo());
    CHECK(running_after_safe_point(features) == defaults);
}

TEST_CASE("each profile undoes only its own edits") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "first"};
    const profile_id first = configs.active();
    const profile_id second = configs.create("second");
    configs.edit({set_scale(2.0F)});

    REQUIRE(configs.switch_to(second).has_value());
    CHECK_FALSE(configs.has_undo());
    configs.undo();
    CHECK(running_after_safe_point(features) == defaults);

    REQUIRE(configs.switch_to(first).has_value());
    CHECK(running_after_safe_point(features).scale == setting_value{2.0F});
    configs.undo();
    CHECK(running_after_safe_point(features).scale == setting_value{1.0F});
}

TEST_CASE("a selected scope's override wins over the base, falling back along the scopes") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "scoped"};
    configs.edit_in(rifles);
    configs.edit({set_scale(2.0F)});
    // Nothing selected yet: the override waits in its layer.
    CHECK(running_after_safe_point(features).scale == setting_value{1.0F});

    configs.select_scopes({rifle, rifles});
    CHECK(running_after_safe_point(features).scale == setting_value{2.0F});

    configs.edit_in(rifle);
    configs.edit({set_scale(3.0F)});
    CHECK(running_after_safe_point(features).scale == setting_value{3.0F});

    configs.select_scopes({pistols});
    CHECK(running_after_safe_point(features).scale == setting_value{1.0F});
    configs.edit_in(std::nullopt);
    configs.edit({set_scale(4.0F)});
    CHECK(running_after_safe_point(features).scale == setting_value{4.0F});

    configs.select_scopes({rifle, rifles});
    CHECK(running_after_safe_point(features).scale == setting_value{3.0F});
}

TEST_CASE("reverting a scope's override falls back, and undo brings the override back") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "scoped"};
    configs.select_scopes({rifle, rifles});
    configs.edit_in(rifles);
    configs.edit({set_scale(2.0F)});
    configs.edit_in(rifle);
    configs.edit({set_scale(3.0F)});

    configs.revert(scale_place);
    CHECK(running_after_safe_point(features).scale == setting_value{2.0F});
    CHECK_FALSE(
        configs.profiles().front().overrides.contains({.scope = rifle, .place = scale_place})
    );

    configs.undo();
    CHECK(running_after_safe_point(features).scale == setting_value{3.0F});
}

TEST_CASE("a duplicate copies values, binds and overrides, and changes apart from its source") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "source"};
    const profile_id source = configs.active();
    configs.edit_in(rifles);
    configs.edit({set_scale(2.0F), change_bind{.feature = tracker, .bind = held_bind}});

    const std::optional<profile_id> copy = configs.duplicate(source, "copy");
    REQUIRE(copy.has_value());
    REQUIRE(configs.switch_to(copy.value_or(profile_id{})).has_value());
    configs.edit_in(std::nullopt);
    configs.edit({make_loud()});

    const profile& original = configs.profiles().front();
    const profile& copied = configs.profiles().back();
    CHECK(copied.name == "copy");
    CHECK(copied.overrides == original.overrides);
    CHECK(copied.binds == original.binds);
    CHECK(copied.values.at(loud_place) == setting_value{true});
    CHECK(original.values.at(loud_place) == setting_value{false});
    CHECK(!configs.duplicate(profile_id{99}, "nothing").has_value());
}

TEST_CASE("removing the active profile switches to another, and the last one stays") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "first"};
    const profile_id first = configs.active();
    const profile_id second = configs.create("second");
    REQUIRE(configs.switch_to(second).has_value());
    configs.edit({set_scale(2.0F)});
    REQUIRE(running_after_safe_point(features).scale == setting_value{2.0F});

    REQUIRE(configs.remove(second).has_value());
    CHECK(configs.active() == first);
    CHECK(running_after_safe_point(features) == defaults);
    CHECK(kept.profiles().size() == 1);

    CHECK(configs.remove(first).error().code == error_code::unsupported);
    CHECK(configs.remove(second).error().code == error_code::not_found);
    CHECK(configs.switch_to(second).error().code == error_code::not_found);
    CHECK(configs.profiles().size() == 1);
}

TEST_CASE("a batch with a change the registry would refuse changes neither profile nor registry") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "only"};
    configs.edit({make_loud(), set_scale(9.0F)});
    configs.edit({make_loud(), change_bind{.feature = feature_id_of<"never wired">, .bind = {}}});

    CHECK_FALSE(configs.has_undo());
    CHECK(configs.profiles().front().values.at(loud_place) == setting_value{false});
    CHECK(running_after_safe_point(features) == defaults);
}

TEST_CASE("a stored profile from another build is completed against what is wired now") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    const setting_place gone{.feature = tracker, .setting = setting_key("tracker/gone")};
    kept.keep({
        .id = profile_id{4},
        .name = "old",
        .values =
            {
                {scale_place, setting_value{2.0F}},
                {gone, setting_value{true}},
                {loud_place, setting_value{2.0F}},
            },
        .overrides = {{{.scope = rifle, .place = scale_place}, setting_value{9.0F}}},
        .binds = {{feature_id_of<"gone">, held_bind}, {tracker, held_bind}},
    });
    const config_store configs{features, kept, "unused"};

    REQUIRE(configs.profiles().size() == 1);
    const profile& completed = configs.profiles().front();
    CHECK(completed.name == "old");
    CHECK(completed.values.at(scale_place) == setting_value{2.0F});
    // A value its setting refuses gives way to the default.
    CHECK(completed.values.at(loud_place) == setting_value{false});
    CHECK_FALSE(completed.values.contains(gone));
    CHECK(completed.values.contains({.feature = tracker, .setting = setting_key("tracker/tint")}));
    CHECK(completed.overrides.empty());
    CHECK(completed.binds.size() == 2);
    CHECK(
        running_after_safe_point(features)
        == running{.is_loud = setting_value{false}, .scale = setting_value{2.0F}, .bind = held_bind}
    );
}

TEST_CASE("feature switches pass through the store to the registry without an undo step") {
    resolve_capabilities();
    const test_clock time;
    registry features{both_features(), everything(), time};
    memory_storage kept;
    config_store configs{features, kept, "only"};
    configs.edit({enable_feature{.feature = tracker}});
    features.safe_point();

    CHECK(features.state(tracker) == feature_state::on);
    CHECK_FALSE(configs.has_undo());
}

}
