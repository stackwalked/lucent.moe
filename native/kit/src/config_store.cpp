#include <lucent/kit/config_store.hpp>

#include <algorithm>
#include <expected>
#include <flat_map>
#include <iterator>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/profile.hpp>
#include <lucent/kit/profile_storage.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::kit {
namespace {

// Enough to walk back a session's worth of fiddling; the oldest steps go first.
constexpr isize max_history = 256;

// Every setting's value as the registry should hold it under the selected scopes.
auto effective(const profile& config, std::span<const scope_id> selected)
    -> std::flat_map<setting_place, setting_value> {
    std::flat_map<setting_place, setting_value> values = config.values;
    for (auto [place, value] : values) {
        for (const scope_id scope : selected) {
            const auto found = config.overrides.find(scoped_place{.scope = scope, .place = place});
            if (found != config.overrides.end()) {
                value = found->second;
                break;
            }
        }
    }
    return values;
}

auto layer_value(const profile& config, std::optional<scope_id> layer, const setting_place& place)
    -> std::optional<setting_value> {
    if (!layer) {
        const auto found = config.values.find(place);
        return found == config.values.end() ? std::nullopt : std::optional{found->second};
    }
    const auto found = config.overrides.find(scoped_place{.scope = *layer, .place = place});
    return found == config.overrides.end() ? std::nullopt : std::optional{found->second};
}

auto set_layer_value(profile& config, const value_edit& edit, std::optional<setting_value> value)
    -> void {
    if (!edit.scope) {
        // The base layer holds every setting, so no step takes one out of it.
        LUCENT_INVARIANT(value.has_value());
        config.values.insert_or_assign(edit.place, *value);
        return;
    }
    const scoped_place scoped{.scope = *edit.scope, .place = edit.place};
    if (value) {
        config.overrides.insert_or_assign(scoped, *value);
    } else {
        config.overrides.erase(scoped);
    }
}

auto bind_of(const profile& config, feature_id feature) -> bind_slot {
    const auto found = config.binds.find(feature);
    return found == config.binds.end() ? bind_slot{} : found->second;
}

enum class direction : u8 {
    // Redo, or as the step was made.
    forward,
    // Undo.
    back,
};

auto apply_step(profile& config, const edit_step& step, direction way) -> void {
    const bool is_forward = way == direction::forward;
    const auto apply_value = [&](const value_edit& edit) {
        set_layer_value(config, edit, is_forward ? edit.after : edit.before);
    };
    const auto apply_bind = [&](const bind_edit& edit) {
        config.binds.insert_or_assign(edit.feature, is_forward ? edit.after : edit.before);
    };
    if (is_forward) {
        std::ranges::for_each(step.values, apply_value);
        std::ranges::for_each(step.binds, apply_bind);
    } else {
        // Back in reverse, so two edits of one setting in a step undo to the first one's before.
        std::ranges::for_each(step.values | std::views::reverse, apply_value);
        std::ranges::for_each(step.binds | std::views::reverse, apply_bind);
    }
}

}

config_store::config_store(registry& features, profile_storage& storage, std::string first_name)
    : m_features{&features}
    , m_storage{&storage} {
    {
        const published<registry_snapshot>::reading shown = features.read();
        for (const feature_snapshot& feature : shown->features) {
            m_described.push_back({.id = feature.id, .descriptions = feature.descriptions});
        }
    }
    for (const profile& loaded : storage.profiles()) {
        m_profiles.push_back(completed(loaded));
    }
    if (m_profiles.empty()) {
        m_profiles.push_back(defaults(profile_id{1}, std::move(first_name)));
    }
    for (const profile& kept : m_profiles) {
        storage.keep(kept);
    }
    m_active = m_profiles.front().id;
    // The registry starts every feature at its defaults with an always bind.
    request_moves(defaults(m_active, {}), {}, {});
}

config_store::~config_store() = default;

auto config_store::features() -> registry& {
    return *m_features;
}

auto config_store::profiles() const -> std::span<const profile> {
    return m_profiles;
}

auto config_store::active() const -> profile_id {
    return m_active;
}

auto config_store::create(std::string name) -> profile_id {
    const profile_id made = mint();
    m_profiles.push_back(defaults(made, std::move(name)));
    m_storage->keep(m_profiles.back());
    return made;
}

auto config_store::duplicate(profile_id source, std::string name) -> std::optional<profile_id> {
    const profile* const copied = find(source);
    if (copied == nullptr) {
        return std::nullopt;
    }
    profile made = *copied;
    made.id = mint();
    made.name = std::move(name);
    m_profiles.push_back(std::move(made));
    m_storage->keep(m_profiles.back());
    return m_profiles.back().id;
}

auto config_store::remove(profile_id removed) -> result<void> {
    if (find(removed) == nullptr) {
        return std::unexpected(error{.code = error_code::not_found, .system_code = 0});
    }
    if (m_profiles.size() == 1) {
        return std::unexpected(error{.code = error_code::unsupported, .system_code = 0});
    }
    if (removed == m_active) {
        const auto other = std::ranges::find_if(m_profiles, [removed](const profile& kept) {
            return kept.id != removed;
        });
        LUCENT_TRY(switch_to(other->id));
    }
    std::erase_if(m_profiles, [removed](const profile& kept) { return kept.id == removed; });
    m_histories.erase(removed);
    m_storage->forget(removed);
    return {};
}

auto config_store::switch_to(profile_id chosen) -> result<void> {
    if (find(chosen) == nullptr) {
        return std::unexpected(error{.code = error_code::not_found, .system_code = 0});
    }
    const profile was = active_profile();
    m_active = chosen;
    request_moves(was, m_selected, {});
    return {};
}

auto config_store::select_scopes(std::vector<scope_id> selected) -> void {
    const std::vector<scope_id> was_selected = std::exchange(m_selected, std::move(selected));
    request_moves(active_profile(), was_selected, {});
}

auto config_store::edit_in(std::optional<scope_id> layer) -> void {
    m_edited = layer;
}

auto config_store::edit(const std::vector<registry_change>& batch) -> void {
    if (!std::ranges::all_of(batch, [this](const registry_change& change) {
            return is_editable(change);
        })) {
        return;
    }
    profile& config = active_profile();
    const profile was = config;
    edit_step step;
    std::vector<registry_change> passed;
    for (const registry_change& change : batch) {
        match(
            change,
            [&](const change_setting& changed) {
                const setting_place place{.feature = changed.feature, .setting = changed.setting};
                const value_edit made{
                    .scope = m_edited,
                    .place = place,
                    .before = layer_value(config, m_edited, place),
                    .after = changed.value,
                };
                set_layer_value(config, made, made.after);
                step.values.push_back(made);
            },
            [&](const change_bind& changed) {
                const bind_edit made{
                    .feature = changed.feature,
                    .before = bind_of(config, changed.feature),
                    .after = changed.bind,
                };
                config.binds.insert_or_assign(made.feature, made.after);
                step.binds.push_back(made);
            },
            [&passed](const auto& other) { passed.emplace_back(other); }
        );
    }
    commit(std::move(step));
    request_moves(was, m_selected, std::move(passed));
}

auto config_store::revert(setting_place place) -> void {
    if (!m_edited) {
        return;
    }
    profile& config = active_profile();
    const std::optional<setting_value> overridden = layer_value(config, m_edited, place);
    if (!overridden) {
        return;
    }
    const profile was = config;
    const value_edit made{.scope = m_edited, .place = place, .before = overridden, .after = {}};
    set_layer_value(config, made, made.after);
    commit(edit_step{.values = {made}, .binds = {}});
    request_moves(was, m_selected, {});
}

auto config_store::undo() -> void {
    history& steps = m_histories[m_active];
    if (steps.undoable.empty()) {
        return;
    }
    profile& config = active_profile();
    const profile was = config;
    edit_step step = std::move(steps.undoable.back());
    steps.undoable.pop_back();
    apply_step(config, step, direction::back);
    steps.redoable.push_back(std::move(step));
    m_storage->keep(config);
    request_moves(was, m_selected, {});
}

auto config_store::redo() -> void {
    history& steps = m_histories[m_active];
    if (steps.redoable.empty()) {
        return;
    }
    profile& config = active_profile();
    const profile was = config;
    edit_step step = std::move(steps.redoable.back());
    steps.redoable.pop_back();
    apply_step(config, step, direction::forward);
    steps.undoable.push_back(std::move(step));
    m_storage->keep(config);
    request_moves(was, m_selected, {});
}

auto config_store::has_undo() const -> bool {
    const auto found = m_histories.find(m_active);
    return found != m_histories.end() && !found->second.undoable.empty();
}

auto config_store::has_redo() const -> bool {
    const auto found = m_histories.find(m_active);
    return found != m_histories.end() && !found->second.redoable.empty();
}

auto config_store::find(profile_id wanted) -> profile* {
    const auto found = std::ranges::find(m_profiles, wanted, &profile::id);
    return found == m_profiles.end() ? nullptr : &*found;
}

auto config_store::find(profile_id wanted) const -> const profile* {
    const auto found = std::ranges::find(m_profiles, wanted, &profile::id);
    return found == m_profiles.end() ? nullptr : &*found;
}

auto config_store::active_profile() -> profile& {
    profile* const found = find(m_active);
    LUCENT_INVARIANT(found != nullptr);
    return *found;
}

auto config_store::description(setting_place place) const -> const setting_description* {
    const auto feature = std::ranges::find(m_described, place.feature, &described_feature::id);
    if (feature == m_described.end()) {
        return nullptr;
    }
    const auto setting =
        std::ranges::find(feature->descriptions, place.setting, &setting_description::id);
    return setting == feature->descriptions.end() ? nullptr : &*setting;
}

auto config_store::defaults(profile_id id, std::string name) const -> profile {
    profile made{.id = id, .name = std::move(name), .values = {}, .overrides = {}, .binds = {}};
    for (const described_feature& feature : m_described) {
        for (const setting_description& setting : feature.descriptions) {
            made.values.insert_or_assign(
                setting_place{.feature = feature.id, .setting = setting.id}, setting.initial
            );
        }
        made.binds.insert_or_assign(feature.id, bind_slot{});
    }
    return made;
}

auto config_store::completed(const profile& loaded) const -> profile {
    profile made = defaults(loaded.id, loaded.name);
    const auto is_accepted = [this](const setting_place& place, const setting_value& value) {
        const setting_description* const setting = description(place);
        return setting != nullptr && is_valid(*setting, value);
    };
    for (const auto [place, value] : loaded.values) {
        if (is_accepted(place, value)) {
            made.values.insert_or_assign(place, value);
        }
    }
    for (const auto [scoped, value] : loaded.overrides) {
        if (is_accepted(scoped.place, value)) {
            made.overrides.insert_or_assign(scoped, value);
        }
    }
    for (const auto [feature, bind] : loaded.binds) {
        if (made.binds.contains(feature)) {
            made.binds.insert_or_assign(feature, bind);
        }
    }
    return made;
}

auto config_store::mint() const -> profile_id {
    const auto newest = std::ranges::max_element(m_profiles, {}, [](const profile& kept) {
        return std::to_underlying(kept.id);
    });
    return profile_id{newest == m_profiles.end() ? 1 : std::to_underlying(newest->id) + 1};
}

auto config_store::is_editable(const registry_change& change) const -> bool {
    return match(
        change,
        [this](const change_setting& changed) {
            const setting_description* const setting =
                description({.feature = changed.feature, .setting = changed.setting});
            return setting != nullptr && is_valid(*setting, changed.value);
        },
        [this](const change_bind& changed) {
            return std::ranges::contains(m_described, changed.feature, &described_feature::id);
        },
        // The registry judges the rest.
        [](const auto&) { return true; }
    );
}

auto config_store::commit(edit_step step) -> void {
    if (step.values.empty() && step.binds.empty()) {
        return;
    }
    history& steps = m_histories[m_active];
    steps.undoable.push_back(std::move(step));
    if (std::ssize(steps.undoable) > max_history) {
        steps.undoable.erase(steps.undoable.begin());
    }
    steps.redoable.clear();
    m_storage->keep(active_profile());
}

auto config_store::request_moves(
    const profile& was, std::span<const scope_id> was_selected, std::vector<registry_change> extra
) -> void {
    const profile& now = active_profile();
    const std::flat_map<setting_place, setting_value> before = effective(was, was_selected);
    std::vector<registry_change> batch;
    for (const auto [place, value] : effective(now, m_selected)) {
        const auto found = before.find(place);
        if (found == before.end() || found->second != value) {
            batch.emplace_back(
                change_setting{.feature = place.feature, .setting = place.setting, .value = value}
            );
        }
    }
    for (const auto [feature, bind] : now.binds) {
        if (bind_of(was, feature) != bind) {
            batch.emplace_back(change_bind{.feature = feature, .bind = bind});
        }
    }
    std::ranges::move(extra, std::back_inserter(batch));
    if (!batch.empty()) {
        m_features->request(std::move(batch));
    }
}

}
