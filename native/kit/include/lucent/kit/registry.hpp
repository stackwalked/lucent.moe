#pragma once

#include <array>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <variant>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/canvas.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/kit/wiring.hpp>

namespace lucent::kit {

// Which features the member may run. A release build's lease client feeds each lease's grant; the
// registry starts from default_entitlements() until the first one lands.
struct entitlements {
    bool is_everything = false;
    std::vector<feature_id> features;

    auto operator==(const entitlements&) const -> bool = default;
};

// Every feature in a dev build, none in any other: a release runs only what a lease grants.
auto default_entitlements() -> entitlements;

// What other threads ask of the registry. Each takes effect at a safe point.
struct enable_feature {
    feature_id feature{};

    auto operator==(const enable_feature&) const -> bool = default;
};

struct disable_feature {
    feature_id feature{};

    auto operator==(const disable_feature&) const -> bool = default;
};

// A person's reset of a failed feature: it comes back off, with fresh state of its own.
struct reset_feature {
    feature_id feature{};

    auto operator==(const reset_feature&) const -> bool = default;
};

struct change_setting {
    feature_id feature{};
    setting_id setting{};
    setting_value value;

    auto operator==(const change_setting&) const -> bool = default;
};

struct replace_entitlements {
    entitlements entitled;

    auto operator==(const replace_entitlements&) const -> bool = default;
};

// A new bind for the feature's switch. A toggle starts inactive under it.
struct change_bind {
    feature_id feature{};
    bind_slot bind;

    auto operator==(const change_bind&) const -> bool = default;
};

// The lease lapsed (the server is unreachable): every feature that is on stops, without losing
// its own state, and the person's choices stand. Every feature alike, with no per-feature
// exception: protection.md "Running" says nothing runs without a server.
struct lapse_lease {
    auto operator==(const lapse_lease&) const -> bool = default;
};

// A renewal landed after a lapse: the stopped features run again as they were.
struct resume_lease {
    auto operator==(const resume_lease&) const -> bool = default;
};

// The builds of the game modules loaded now, which a feature that fails from here on records.
struct replace_module_builds {
    std::vector<bundle::module_key> builds;

    auto operator==(const replace_module_builds&) const -> bool = default;
};

using registry_change = std::variant<
    enable_feature,
    disable_feature,
    reset_feature,
    change_setting,
    replace_entitlements,
    change_bind,
    lapse_lease,
    resume_lease,
    replace_module_builds>;

// What a failed feature remembers of its failure until a person resets it, for health telemetry.
struct feature_failure {
    // The game module builds current when it failed, as the registry was last told them.
    std::vector<bundle::module_key> builds;

    auto operator==(const feature_failure&) const -> bool = default;
};

struct feature_stats {
    i64 runs = 0;
    // Ticks it was due but a part it needs wasn't built.
    i64 skips = 0;
    i64 faults = 0;
    // Spent in its ticks, by the registry's clock.
    std::chrono::nanoseconds busy{0};

    auto operator==(const feature_stats&) const -> bool = default;
};

// No ==: descriptions is a span, and two snapshots are told apart by their revision.
struct feature_snapshot {
    feature_id id{};
    feature_state state = feature_state::off;
    // Its settings as describe() lists them: static data, valid as long as the module is loaded.
    std::span<const setting_description> descriptions;
    // One per description, in the same order.
    std::vector<setting_value> settings;
    bind_slot bind;
    // On, and its bind lets it run now.
    bool is_active = false;
    // Present while it is failed.
    std::optional<feature_failure> failure;
};

// The registry as one safe point left it, for readers on any thread.
struct registry_snapshot {
    // Counts publishes: a reader can tell a newer snapshot from one it saw.
    u64 revision = 0;
    // In wiring order.
    std::vector<feature_snapshot> features;
};

// The wired features, their states, settings and binds, and their dispatch.
//
// Threads: one thread ticks (a kit thread, or a hook kit controls): it calls feed(), safe_point()
// and dispatch() and asks state() and stats(). Any thread may request() and read(). Every change a
// request carries is applied at the next safe point, between dispatches, so a tick sees one state
// and one settings value throughout; snapshots for other threads are published there, whole.
//
// A feature runs while it is on and active: lifecycle (on, off, failed, lapsed) is the person's
// choice and the world's verdict, activity is its bind's reading of the keys.
class registry final {
public:
    // Before the first tick: availability is read from the capabilities as resolved now, and the
    // first snapshot is published.
    registry(wiring wired, entitlements entitled, const clock& time);
    registry(const registry&) = delete ("other threads hold its address");
    auto operator=(const registry&) -> registry& = delete ("other threads hold its address");
    registry(registry&&) = delete ("other threads hold its address");
    auto operator=(registry&&) -> registry& = delete ("other threads hold its address");
    ~registry();

    // Any thread. The batch applies whole at one safe point, or not at all when any change in it
    // names a feature or setting that isn't wired or a value its setting refuses.
    auto request(std::vector<registry_change> batch) -> void;

    // The tick thread, between dispatches. Applies what was requested, notices capabilities that
    // became available (a module that loaded late) and publishes a snapshot if anything changed.
    // Never waits: a request being queued right now is left for the next safe point, and so is a
    // snapshot no free slot could take.
    auto safe_point() -> void;

    // The tick thread, before the safe point: the keys since the last feed, which binds read.
    // Presses count only for features on at the time.
    auto feed(const key_input& keys) -> void;

    // The tick thread. Ticks every feature that is on and active, in wiring order, each inside
    // contain(). A fault turns that feature failed at once; readers see it from the next safe
    // point.
    auto dispatch(const view_set& parts) -> void;

    // The tick thread, which draws: the render thread while the overlay's frames are the ticks.
    // Draws every feature that is on, active and draws, in wiring order, each inside contain(),
    // with dispatch's fault rule. The parts are render-thread snapshots, not the tick's.
    auto draw(const view_set& parts, canvas& onto) -> void;

    // The tick thread. Empty for a feature that isn't wired.
    auto state(feature_id feature) const -> std::optional<feature_state>;
    auto stats(feature_id feature) const -> std::optional<feature_stats>;

    // Any thread: the latest published snapshot. The reading must not outlive the registry.
    auto read() -> published<registry_snapshot>::reading;

private:
    struct wired_feature {
        std::unique_ptr<detail::feature_entry> entry;
        feature_stats stats;
        // A person's choice, which outlasts losing the entitlement, a capability or the lease.
        bool is_enabled = false;
        bool is_available = false;
        // Present while it is failed.
        std::optional<feature_failure> failure;
        bind_slot bind;
        // A toggle bind's state: pressed an odd number of times since it was set or the feature
        // was turned off.
        bool is_toggled = false;
    };

    static auto adopt(wiring wired) -> std::vector<wired_feature>;
    auto run_each(stdx::function_ref<tick_outcome(detail::feature_entry&)> run) -> void;
    auto find(feature_id feature) -> wired_feature*;
    auto find(feature_id feature) const -> const wired_feature*;
    auto state_of(const wired_feature& wired) const -> feature_state;
    auto is_active(const wired_feature& wired) const -> bool;
    auto is_held(input_key key) const -> bool;
    auto is_applicable(const registry_change& change) const -> bool;
    auto apply(const registry_change& change) -> void;
    auto press(input_key key) -> void;
    auto snapshot(u64 revision) const -> registry_snapshot;

    std::vector<wired_feature> m_features;
    entitlements m_entitled;
    bool m_is_lapsed = false;
    std::vector<bundle::module_key> m_builds;
    // By input_key: down now, as the feeds left it.
    std::array<bool, 256> m_held{};
    const clock* m_clock;
    std::mutex m_requests_lock;
    std::vector<std::vector<registry_change>> m_requests;
    // Whether the published snapshot is behind what the tick thread holds.
    bool m_is_stale = false;
    u64 m_revision = 0;
    published<registry_snapshot> m_published;
};

}
