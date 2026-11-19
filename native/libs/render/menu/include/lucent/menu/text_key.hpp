#pragma once

#include <string>
#include <string_view>
#include <variant>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::menu {

// One of the menu's own words (a status, a button), by the hash of its name: the menu's chrome
// reaches the binary no more than a feature's name does.
enum class phrase_id : u64 {};

// Phrase names hash with their own seed. The keyed identifier hash replaces this through
// phrase_key alone.
inline constexpr u64 dev_phrase_seed = 0x6c75'6365'6e74'7068;

consteval auto phrase_key(std::string_view name) noexcept -> phrase_id {
    return phrase_id{kit::fact_name_hash(dev_phrase_seed, name)};
}

namespace phrases {

inline constexpr phrase_id search = phrase_key("search");
inline constexpr phrase_id unavailable = phrase_key("unavailable");
inline constexpr phrase_id unentitled = phrase_key("unentitled");
inline constexpr phrase_id failed = phrase_key("failed");
inline constexpr phrase_id reset = phrase_key("reset");
inline constexpr phrase_id red = phrase_key("red");
inline constexpr phrase_id green = phrase_key("green");
inline constexpr phrase_id blue = phrase_key("blue");
inline constexpr phrase_id alpha = phrase_key("alpha");

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

// What a piece of menu text is looked up by: only hashes, never a name.
using text_key = std::variant<feature_text, setting_text, option_text, phrase_text>;

// Neutral text for a key the catalog lacks: a hash mark and the key's own hash in hex, so a missing
// entry is visible, stable across frames, and still searchable.
auto placeholder(const text_key& key) -> std::string;

}
