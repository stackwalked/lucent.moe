#include <lucent/kit/registry.hpp>

#include <algorithm>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/core/contain.hpp>
#include <lucent/core/match.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/kit/canvas.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/kit/wiring.hpp>

#include "dev.hpp"
#include "lucent/core/fault.hpp"

namespace lucent::kit {
namespace {

auto is_entitled(const entitlements& entitled, feature_id feature) -> bool {
    return entitled.is_everything || std::ranges::contains(entitled.features, feature);
}

}

auto default_entitlements() -> entitlements {
    return entitlements{.is_everything = is_dev_build, .features = {}};
}

registry::registry(wiring wired, entitlements entitled, const clock& time)
    : m_features{adopt(std::move(wired))}
    , m_entitled{std::move(entitled)}
    , m_clock{&time}
    , m_published{snapshot(0)} {}

registry::~registry() = default;

auto registry::adopt(wiring wired) -> std::vector<wired_feature> {
    std::vector<wired_feature> features;
    features.reserve(wired.m_entries.size());
    for (std::unique_ptr<detail::feature_entry>& entry : wired.m_entries) {
        const bool is_available = entry->is_available();
        features.push_back(
            wired_feature{
                .entry = std::move(entry),
                .stats = feature_stats{.runs = 0, .skips = 0, .faults = 0, .busy = {}},
                .is_enabled = false,
                .is_failed = false,
                .is_available = is_available,
            }
        );
    }
    return features;
}

auto registry::request(std::vector<registry_change> batch) -> void {
    // Held only to append or to swap the queue out, never across anything that waits.
    const std::scoped_lock<std::mutex> locked{m_requests_lock};
    m_requests.push_back(std::move(batch));
}

auto registry::safe_point() -> void {
    std::vector<std::vector<registry_change>> batches;
    {
        const std::unique_lock<std::mutex> locked{m_requests_lock, std::try_to_lock};
        if (locked.owns_lock()) {
            batches = std::exchange(m_requests, {});
        }
    }
    for (const std::vector<registry_change>& batch : batches) {
        if (!std::ranges::all_of(batch, [this](const registry_change& change) {
                return is_applicable(change);
            })) {
            continue;
        }
        for (const registry_change& change : batch) {
            apply(change);
        }
        m_is_stale = true;
    }
    for (wired_feature& wired : m_features) {
        const bool is_available = wired.entry->is_available();
        if (is_available != wired.is_available) {
            wired.is_available = is_available;
            m_is_stale = true;
        }
    }
    if (!m_is_stale) {
        return;
    }
    const u64 revision = m_revision + 1;
    // Refused only while every other slot is being read: offered again at the next safe point.
    if (!m_published.publish(snapshot(revision)).has_value()) {
        m_revision = revision;
        m_is_stale = false;
    }
}

auto registry::dispatch(const view_set& parts) -> void {
    run_each([&parts](detail::feature_entry& entry) { return entry.tick(parts); });
}

auto registry::draw(const view_set& parts, canvas& onto) -> void {
    run_each([&parts, &onto](detail::feature_entry& entry) { return entry.draw(parts, onto); });
}

// A tick and a draw count alike in a feature's stats: a feature that both ticks and draws runs
// twice a frame.
auto registry::run_each(stdx::function_ref<tick_outcome(detail::feature_entry&)> run) -> void {
    for (wired_feature& wired : m_features) {
        if (state_of(wired) != feature_state::on) {
            continue;
        }
        const clock::time_point started = m_clock->now();
        tick_outcome outcome = tick_outcome::skipped;
        const contained<void> ran = contain([&] { outcome = run(*wired.entry); });
        wired.stats.busy += m_clock->now() - started;
        if (!ran) {
            wired.is_failed = true;
            ++wired.stats.faults;
            m_is_stale = true;
            if constexpr (is_dev_build) {
                detail::report_feature_fault(wired.entry->id(), ran.error());
            }
            continue;
        }
        switch (outcome) {
        case tick_outcome::ran:
            ++wired.stats.runs;
            break;
        case tick_outcome::skipped:
            ++wired.stats.skips;
            break;
        case tick_outcome::idle:
            break;
        }
    }
}

auto registry::state(feature_id feature) const -> std::optional<feature_state> {
    const wired_feature* const wired = find(feature);
    return wired == nullptr ? std::nullopt : std::optional{state_of(*wired)};
}

auto registry::stats(feature_id feature) const -> std::optional<feature_stats> {
    const wired_feature* const wired = find(feature);
    return wired == nullptr ? std::nullopt : std::optional{wired->stats};
}

auto registry::read() -> published<registry_snapshot>::reading {
    return m_published.read();
}

auto registry::find(feature_id feature) -> wired_feature* {
    const auto found = std::ranges::find(m_features, feature, [](const wired_feature& wired) {
        return wired.entry->id();
    });
    return found == m_features.end() ? nullptr : &*found;
}

auto registry::find(feature_id feature) const -> const wired_feature* {
    const auto found = std::ranges::find(m_features, feature, [](const wired_feature& wired) {
        return wired.entry->id();
    });
    return found == m_features.end() ? nullptr : &*found;
}

auto registry::state_of(const wired_feature& wired) const -> feature_state {
    if (!wired.is_available) {
        return feature_state::unavailable;
    }
    if (!is_entitled(m_entitled, wired.entry->id())) {
        return feature_state::unentitled;
    }
    if (wired.is_failed) {
        return feature_state::failed;
    }
    return wired.is_enabled ? feature_state::on : feature_state::off;
}

auto registry::is_applicable(const registry_change& change) const -> bool {
    return match(
        change,
        [this](const enable_feature& enabled) { return find(enabled.feature) != nullptr; },
        [this](const disable_feature& disabled) { return find(disabled.feature) != nullptr; },
        [this](const reset_feature& reset) { return find(reset.feature) != nullptr; },
        [this](const change_setting& changed) {
            const wired_feature* const wired = find(changed.feature);
            if (wired == nullptr) {
                return false;
            }
            const std::span<const setting_description> described = wired->entry->descriptions();
            const auto setting =
                std::ranges::find(described, changed.setting, &setting_description::id);
            return setting != described.end() && is_valid(*setting, changed.value);
        },
        [](const replace_entitlements&) { return true; }
    );
}

auto registry::apply(const registry_change& change) -> void {
    match(
        change,
        [this](const enable_feature& enabled) { find(enabled.feature)->is_enabled = true; },
        [this](const disable_feature& disabled) { find(disabled.feature)->is_enabled = false; },
        [this](const reset_feature& reset) {
            wired_feature& wired = *find(reset.feature);
            if (!wired.is_failed) {
                return;
            }
            wired.is_failed = false;
            wired.is_enabled = false;
            wired.entry->restart();
        },
        [this](const change_setting& changed) {
            find(changed.feature)->entry->set(changed.setting, changed.value);
        },
        [this](const replace_entitlements& replaced) { m_entitled = replaced.entitled; }
    );
}

auto registry::snapshot(u64 revision) const -> registry_snapshot {
    registry_snapshot taken{.revision = revision, .features = {}};
    taken.features.reserve(m_features.size());
    for (const wired_feature& wired : m_features) {
        taken.features.push_back(
            feature_snapshot{
                .id = wired.entry->id(),
                .state = state_of(wired),
                .descriptions = wired.entry->descriptions(),
                .settings = wired.entry->values(),
            }
        );
    }
    return taken;
}

}
