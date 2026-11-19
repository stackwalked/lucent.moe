#pragma once

#include <concepts>
#include <string_view>
#include <type_traits>

#include <lucent/core/fixed_string.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::kit {

// A feature, by the hash of its name. The name never reaches the binary.
enum class feature_id : u64 {};

// Feature names hash with their own seed. The keyed identifier hash replaces this through
// feature_key alone.
inline constexpr u64 dev_feature_seed = 0x6c75'6365'6e74'6665;

consteval auto feature_key(std::string_view name) noexcept -> feature_id {
    return feature_id{fact_name_hash(dev_feature_seed, name)};
}

// What a feature declares itself by: `static constexpr kit::feature_id id =
// kit::feature_id_of<"box_esp">;`.
template <fixed_string Name>
inline constexpr feature_id feature_id_of = feature_key(Name.as_view());

enum class feature_state : u8 {
    // A capability it needs is unavailable in this game build.
    unavailable,
    // The member isn't entitled to it.
    unentitled,
    off,
    on,
    // It faulted, and stays stopped until a person resets it.
    failed,
};

// What a domain hands features: a view (plain values for this tick) or a stage token, each naming
// the capability it is built from.
template <typename T>
concept backed = capability_like<typename T::backing>;

// The parts a feature can't run without: it is unavailable while any one's capability is.
template <backed... Parts>
struct needs {};

// The parts a feature uses when they are there; each degrades alone.
template <backed... Parts>
struct wants {};

template <typename T>
inline constexpr bool is_needs = false;

template <typename... Parts>
inline constexpr bool is_needs<needs<Parts...>> = true;

template <typename T>
inline constexpr bool is_wants = false;

template <typename... Parts>
inline constexpr bool is_wants<wants<Parts...>> = true;

template <typename Part, typename List>
inline constexpr bool is_listed = false;

template <typename Part, typename... Parts>
inline constexpr bool is_listed<Part, needs<Parts...>> = (std::same_as<Part, Parts> || ...);

template <typename Part, typename... Parts>
inline constexpr bool is_listed<Part, wants<Parts...>> = (std::same_as<Part, Parts> || ...);

// A feature as it declares itself: its id, the parts it needs and wants, and its settings. What
// it runs is checked where it is wired.
template <typename F>
concept feature_like = std::default_initializable<F> && std::movable<F> && requires {
    requires std::same_as<std::remove_cv_t<decltype(F::id)>, feature_id>;
    requires is_needs<typename F::needs>;
    requires is_wants<typename F::wants>;
    requires describable<typename F::settings>;
};

// A class, complete or not yet.
template <typename T>
concept class_type = std::is_class_v<T>;

// Whether Part is among the parts F needs: the only parts its context gives it whole.
template <typename Part, typename F>
concept needed_by = feature_like<F> && is_listed<Part, typename F::needs>;

// Whether Part is among the parts F wants: the only parts its context gives it maybe.
template <typename Part, typename F>
concept wanted_by = feature_like<F> && is_listed<Part, typename F::wants>;

}
