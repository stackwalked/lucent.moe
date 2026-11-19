#pragma once

#include <algorithm>
#include <array>
#include <concepts>
#include <optional>
#include <ranges>
#include <span>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>

#include <lucent/core/fixed_string.hpp>
#include <lucent/core/match.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// A setting, by the hash of its path within its feature ("box/color"). The path never reaches the
// binary: the menu's text arrives keyed by these ids.
enum class setting_id : u64 {};

// A setting's id: the identifier hash of its path under this build's setting subkey, as features'.
consteval auto setting_key(std::string_view path) noexcept -> setting_id {
    return setting_id{identifier_hash(build::setting_subkey, path)};
}

// A colour as draw::color holds it, so the two convert field for field.
struct color {
    u8 r = 0;
    u8 g = 0;
    u8 b = 0;
    u8 a = 0;

    auto operator==(const color&) const -> bool = default;
};

enum class setting_kind : u8 { toggle, number, choice, color };

// A number setting's inclusive bounds, and the step a control moves it by.
struct number_range {
    f32 min = 0.0F;
    f32 max = 0.0F;
    f32 step = 0.0F;

    auto operator==(const number_range&) const -> bool = default;
};

// A setting's value, whatever its kind: a toggle's bool, a number's f32, a choice's option index,
// a colour.
using setting_value = std::variant<bool, f32, isize, color>;

// What config, the menu and scripts know of one setting: enough to show it, store it and check a
// value for it, without knowing the settings type.
struct setting_description {
    setting_id id{};
    setting_kind kind = setting_kind::toggle;
    // A number's; zero for every other kind.
    number_range range;
    // A choice's options, in index order; empty for every other kind.
    std::span<const setting_id> options;
    // The settings type's default.
    setting_value initial;
};

// The value's alternative when it holds a T.
template <typename T>
constexpr auto held(const setting_value& value) -> std::optional<T> {
    return match(
        value,
        [](const T& wanted) { return std::optional<T>{wanted}; },
        [](const auto&) { return std::optional<T>{}; }
    );
}

// The kind whose values a setting_value alternative holds. A new alternative fails to compile
// until it has a kind.
template <typename T>
consteval auto kind_holding() -> setting_kind {
    if constexpr (std::same_as<T, bool>) {
        return setting_kind::toggle;
    } else if constexpr (std::same_as<T, f32>) {
        return setting_kind::number;
    } else if constexpr (std::same_as<T, isize>) {
        return setting_kind::choice;
    } else {
        static_assert(std::same_as<T, color>, "every setting_value alternative has a kind");
        return setting_kind::color;
    }
}

constexpr auto kind_of(const setting_value& value) -> setting_kind {
    return match(value, [](const auto& held) {
        return kind_holding<std::remove_cvref_t<decltype(held)>>();
    });
}

// Whether the setting can hold value: its kind's alternative, a number inside its range (never
// NaN), an option that exists.
constexpr auto is_valid(const setting_description& setting, const setting_value& value) -> bool {
    if (kind_of(value) != setting.kind) {
        return false;
    }
    if (const std::optional<f32> number = held<f32>(value)) {
        return *number >= setting.range.min && *number <= setting.range.max;
    }
    if (const std::optional<isize> option = held<isize>(value)) {
        return *option >= 0 && *option < std::ssize(setting.options);
    }
    return true;
}

// One setting of a Settings type: its description, and how to move a value in and out of the
// type's member.
template <typename Settings>
struct setting {
    using reader = auto (*)(const Settings& settings) -> setting_value;
    // Only with a value is_valid accepts for the description.
    using writer = auto (*)(Settings& settings, const setting_value& value) -> void;

    setting_description description;
    reader read = nullptr;
    writer write = nullptr;
};

template <typename T>
inline constexpr bool is_setting_list = false;

template <typename Settings, usize N>
inline constexpr bool is_setting_list<std::array<setting<Settings>, N>> = true;

// A feature's settings: a plain value whose defaults are its default members, and which describes
// each of its settings through a static describe().
template <typename T>
concept describable = std::default_initializable<T> && std::copyable<T> && requires {
    requires is_setting_list<decltype(T::describe())>;
    requires std::same_as<typename decltype(T::describe())::value_type, setting<T>>;
};

// For a feature with nothing to set.
struct no_settings {
    static constexpr auto describe() -> std::array<setting<no_settings>, 0> {
        return {};
    }
};

namespace detail {

template <typename Member>
struct member_parts;

template <typename Owner, typename Value>
struct member_parts<Value Owner::*> {
    using owner = Owner;
    using value = Value;
};

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a member pointer template argument reads as `(member)`.

template <auto Member>
using owner_of = member_parts<decltype(Member)>::owner;

template <auto Member>
using member_of = member_parts<decltype(Member)>::value;

template <auto Member>
constexpr auto read_member(const owner_of<Member>& settings) -> setting_value {
    if constexpr (std::is_scoped_enum_v<member_of<Member>>) {
        return setting_value{static_cast<isize>(std::to_underlying(settings.*Member))};
    } else {
        return setting_value{settings.*Member};
    }
}

template <auto Member>
constexpr auto write_member(owner_of<Member>& settings, const setting_value& value) -> void {
    if constexpr (std::is_scoped_enum_v<member_of<Member>>) {
        const std::optional<isize> option = held<isize>(value);
        LUCENT_INVARIANT(option.has_value());
        settings.*Member = static_cast<member_of<Member>>(*option);
    } else {
        const std::optional<member_of<Member>> given = held<member_of<Member>>(value);
        LUCENT_INVARIANT(given.has_value());
        settings.*Member = *given;
    }
}

template <fixed_string Path, auto Member>
consteval auto make_setting(
    setting_kind kind, number_range range, std::span<const setting_id> options
) -> setting<owner_of<Member>> {
    return setting<owner_of<Member>>{
        .description =
            setting_description{
                .id = setting_key(Path.as_view()),
                .kind = kind,
                .range = range,
                .options = options,
                .initial = read_member<Member>(owner_of<Member>{}),
            },
        .read = &read_member<Member>,
        .write = &write_member<Member>,
    };
}

template <fixed_string... Options>
inline constexpr std::array<setting_id, sizeof...(Options)> option_ids{
    setting_key(Options.as_view())...,
};

}

// The setting kinds a settings type's describe() lists, one per member: the path names it, the
// member pointer says where it lives.

template <fixed_string Path, auto Member>
    requires std::same_as<detail::member_of<Member>, bool>
consteval auto toggle() -> setting<detail::owner_of<Member>> {
    return detail::make_setting<Path, Member>(setting_kind::toggle, {}, {});
}

template <fixed_string Path, auto Member>
    requires std::same_as<detail::member_of<Member>, f32>
consteval auto number(number_range range) -> setting<detail::owner_of<Member>> {
    LUCENT_INVARIANT(range.min <= range.max && range.step > 0.0F);
    return detail::make_setting<Path, Member>(setting_kind::number, range, {});
}

// A scoped enum whose enumerators are 0, 1, ... in the order of Options.
template <fixed_string Path, auto Member, fixed_string... Options>
    requires(std::is_scoped_enum_v<detail::member_of<Member>> && sizeof...(Options) >= 2)
consteval auto choice() -> setting<detail::owner_of<Member>> {
    return detail::make_setting<Path, Member>(
        setting_kind::choice, {}, detail::option_ids<Options...>
    );
}

template <fixed_string Path, auto Member>
    requires std::same_as<detail::member_of<Member>, color>
consteval auto color_of() -> setting<detail::owner_of<Member>> {
    return detail::make_setting<Path, Member>(setting_kind::color, {}, {});
}

// NOLINTEND(readability-redundant-parentheses)

// Whether a settings type's describe() is one config and the menu can trust: every path distinct
// and every default a value its setting accepts.
template <describable Settings>
consteval auto is_well_described() -> bool {
    constexpr auto described = Settings::describe();
    std::array<u64, described.size()> ids{};
    for (const auto& [index, listed] : std::views::enumerate(described)) {
        if (!is_valid(listed.description, listed.description.initial)) {
            return false;
        }
        ids.at(static_cast<usize>(index)) = std::to_underlying(listed.description.id);
    }
    std::ranges::sort(ids);
    return std::ranges::adjacent_find(ids) == ids.end();
}

template <describable Settings>
inline constexpr auto settings_of = Settings::describe();

namespace detail {

template <describable Settings>
consteval auto describe_all() -> std::array<setting_description, settings_of<Settings>.size()> {
    std::array<setting_description, settings_of<Settings>.size()> descriptions{};
    std::ranges::transform(
        settings_of<Settings>, descriptions.begin(), &setting<Settings>::description
    );
    return descriptions;
}

}

// Every setting's description, in describe()'s order: what a feature shows outside itself.
template <describable Settings>
inline constexpr auto descriptions_of = detail::describe_all<Settings>();

}
