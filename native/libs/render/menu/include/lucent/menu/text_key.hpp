#pragma once

#include <string>
#include <string_view>
#include <variant>

#include <lucent/kit/bind.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::menu {

// One of the menu's own words (a status, a button), by the hash of its name: the menu's chrome
// reaches the binary no more than a feature's name does.
enum class phrase_id : u64 {};

// A phrase's id: the identifier hash of its name under this build's phrase subkey, as settings'.
consteval auto phrase_key(std::string_view name) noexcept -> phrase_id {
    return phrase_id{identifier_hash(build::phrase_subkey, name)};
}

namespace phrases {

inline constexpr phrase_id search = phrase_key("search");
inline constexpr phrase_id unavailable = phrase_key("unavailable");
inline constexpr phrase_id unentitled = phrase_key("unentitled");
inline constexpr phrase_id failed = phrase_key("failed");
inline constexpr phrase_id reset = phrase_key("reset");
inline constexpr phrase_id lapsed = phrase_key("lapsed");
inline constexpr phrase_id bind = phrase_key("bind");
inline constexpr phrase_id always = phrase_key("always");
inline constexpr phrase_id hold = phrase_key("hold");
inline constexpr phrase_id toggle = phrase_key("toggle");
inline constexpr phrase_id no_key = phrase_key("no_key");
inline constexpr phrase_id press_key = phrase_key("press_key");

}

// A feature's name.
struct feature_text {
    kit::feature_id feature{};

    auto operator<=>(const feature_text&) const = default;
};

// A setting's name. Paths are only distinct within a feature, so the feature is part of the key.
struct setting_text {
    kit::feature_id feature{};
    kit::setting_id setting{};

    auto operator<=>(const setting_text&) const = default;
};

// A choice option's name, under its setting.
struct option_text {
    kit::feature_id feature{};
    kit::setting_id setting{};
    kit::setting_id option{};

    auto operator<=>(const option_text&) const = default;
};

struct phrase_text {
    phrase_id phrase{};

    auto operator<=>(const phrase_text&) const = default;
};

// A key's or mouse button's name, as a bind shows it. Names come from the catalog like every other
// word, so none is in the binary.
struct key_text {
    kit::input_key key{};

    auto operator<=>(const key_text&) const = default;
};

// What a piece of menu text is looked up by: only hashes and key codes, never a name.
using text_key = std::variant<feature_text, setting_text, option_text, phrase_text, key_text>;

// Neutral text for a key the catalog lacks: a hash mark and the key's own hash in hex, so a missing
// entry is visible, stable across frames, and still searchable.
auto placeholder(const text_key& key) -> std::string;

}
