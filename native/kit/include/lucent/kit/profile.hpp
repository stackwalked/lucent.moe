#pragma once

#include <flat_map>
#include <string>

#include <lucent/kit/bind.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::kit {

// A profile, minted by the config store.
enum class profile_id : u64 {};

// A scope settings can be overridden in: a weapon, a weapon's class. Keyed from outside: the
// target's domain names them (cs2's weapon domain, once it exists), kit only compares them.
enum class scope_id : u64 {};

// One setting of one feature.
struct setting_place {
    feature_id feature{};
    setting_id setting{};

    auto operator<=>(const setting_place&) const = default;
};

// A setting as one scope overrides it.
struct scoped_place {
    scope_id scope{};
    setting_place place;

    auto operator<=>(const scoped_place&) const = default;
};

// One full config: a value for every setting of every wired feature, a bind for every feature,
// and the overrides scopes make. A plain value, so a store keeps it however it likes.
struct profile {
    profile_id id{};
    // The person's name for it, UTF-8.
    std::string name;
    std::flat_map<setting_place, setting_value> values;
    // Sparse: a scope overrides only what a person set in it.
    std::flat_map<scoped_place, setting_value> overrides;
    std::flat_map<feature_id, bind_slot> binds;

    auto operator==(const profile&) const -> bool = default;
};

}
