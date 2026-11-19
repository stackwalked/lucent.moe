#pragma once

#include <flat_map>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include <lucent/kit/bind.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/profile.hpp>
#include <lucent/kit/profile_storage.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::kit {

// A setting's value in one layer of a profile: its base values, or one scope's overrides. Absent
// is a scope that doesn't override it.
struct value_edit {
    std::optional<scope_id> scope;
    setting_place place;
    std::optional<setting_value> before;
    std::optional<setting_value> after;

    auto operator==(const value_edit&) const -> bool = default;
};

struct bind_edit {
    feature_id feature{};
    bind_slot before;
    bind_slot after;

    auto operator==(const bind_edit&) const -> bool = default;
};

// What one undo takes back: one edit() batch, or one revert().
struct edit_step {
    std::vector<value_edit> values;
    std::vector<bind_edit> binds;

    auto operator==(const edit_step&) const -> bool = default;
};

// The person's configs: profiles, each a full set of every wired feature's settings and binds,
// with scope overrides, and each with its own undo history. The registry runs the active
// profile: every change here that moves an effective value reaches it as one request, applied
// whole at its next safe point, so a switch never shows a tick half of each profile.
//
// An effective value is the first override found along the selected scopes (most specific
// first: a weapon, then its class), else the base value. Edits go into the edited scope's layer,
// which need not be one selected.
//
// Threads: one thread owns it (the menu's). The registry and the storage must outlive it.
class config_store final {
public:
    // Completes the storage's profiles against what the registry has wired (a setting no longer
    // wired is dropped, a new one takes its default, a value its setting refuses too), or makes a
    // first profile of defaults named first_name when it has none, and requests the first
    // profile's values and binds.
    config_store(registry& features, profile_storage& storage, std::string first_name);
    config_store(const config_store&) = delete ("the menu borrows it");
    auto operator=(const config_store&) -> config_store& = delete ("the menu borrows it");
    config_store(config_store&&) = delete ("the menu borrows it");
    auto operator=(config_store&&) -> config_store& = delete ("the menu borrows it");
    ~config_store();

    // The registry it runs profiles on: the menu reads its snapshot.
    auto features() -> registry&;

    // In creation order.
    auto profiles() const -> std::span<const profile>;
    auto active() const -> profile_id;

    // Every setting at its default, every bind always.
    auto create(std::string name) -> profile_id;
    // Empty when source isn't a profile.
    auto duplicate(profile_id source, std::string name) -> std::optional<profile_id>;
    // Refused for a profile that doesn't exist or the only one left. Removing the active profile
    // switches to the first other one.
    auto remove(profile_id removed) -> result<void>;
    // Refused for a profile that doesn't exist.
    auto switch_to(profile_id chosen) -> result<void>;

    // The scopes in force now, most specific first, from outside (the weapon held, then its
    // class). Empty: base values only.
    auto select_scopes(std::vector<scope_id> selected) -> void;
    // The layer edits go into: a scope's overrides, or the base values when empty.
    auto edit_in(std::optional<scope_id> layer) -> void;

    // A batch as the menu makes it. Settings and binds go into the active profile as one undo
    // step; every change goes on to the registry, settings only where the effective value moved.
    // Applies none of it when any setting or bind names something the registry hasn't wired or a
    // value its setting refuses, as the registry would.
    auto edit(const std::vector<registry_change>& batch) -> void;
    // Drops the edited scope's override of a setting, as one undo step; nothing for the base
    // layer, which has no override to drop.
    auto revert(setting_place place) -> void;

    // The active profile's history: one step back or forward, if there is one.
    auto undo() -> void;
    auto redo() -> void;
    auto has_undo() const -> bool;
    auto has_redo() const -> bool;

private:
    struct described_feature {
        feature_id id{};
        std::span<const setting_description> descriptions;
    };

    struct history {
        std::vector<edit_step> undoable;
        std::vector<edit_step> redoable;
    };

    auto find(profile_id wanted) -> profile*;
    auto find(profile_id wanted) const -> const profile*;
    auto active_profile() -> profile&;
    auto description(setting_place place) const -> const setting_description*;
    auto defaults(profile_id id, std::string name) const -> profile;
    auto completed(const profile& loaded) const -> profile;
    auto mint() const -> profile_id;
    auto is_editable(const registry_change& change) const -> bool;
    auto commit(edit_step step) -> void;
    // Requests what moved from the effective state the registry was given last (was, under
    // was_selected) to the active profile's now, with extra in the same batch.
    auto request_moves(
        const profile& was,
        std::span<const scope_id> was_selected,
        std::vector<registry_change> extra
    ) -> void;

    registry* m_features;
    profile_storage* m_storage;
    std::vector<described_feature> m_described;
    std::vector<profile> m_profiles;
    std::flat_map<profile_id, history> m_histories;
    profile_id m_active{};
    std::vector<scope_id> m_selected;
    std::optional<scope_id> m_edited;
};

}
