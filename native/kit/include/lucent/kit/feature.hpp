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

// A feature's id: the identifier hash of its name under this build's feature subkey, so ids differ
// per release and a shipped id gives back neither the name nor the subkey.
consteval auto feature_key(std::string_view name) noexcept -> feature_id {
    return feature_id{identifier_hash(build::feature_subkey, name)};
}

// What a feature declares itself by: `static constexpr kit::feature_id id =
// kit::feature_id_of<"box_esp">;`.
template <fixed_string Name>
inline constexpr feature_id feature_id_of = feature_key(Name.as_view());

inline constexpr usize max_feature_tag_size = 64;

// The tag an entitlement grants a feature by ("visuals", "aim"), the platform's FeatureTag:
// [a-z0-9][a-z0-9._-]{0,63}. Unlike its name, a feature's tag ships, in the feature section: the
// server maps an entitlement's tags to this release's keyed ids through the release manifest,
// which `facts manifest` reads from the module file. Tags name product groups members already see
// on the product page, so they give nothing away. A feature declares one:
// `static constexpr kit::feature_tag tag{"visuals"};`.
class feature_tag final {
public:
    consteval explicit feature_tag(std::string_view text) {
        // A tag the platform can't parse would leave the feature ungrantable but by "*".
        LUCENT_INVARIANT(is_feature_tag(text));
        std::ranges::copy(text, m_text.begin());
    }

    // NUL-padded to max_feature_tag_size.
    constexpr auto as_padded() const -> const std::array<char, max_feature_tag_size>& {
        return m_text;
    }

    static constexpr auto is_feature_tag(std::string_view text) -> bool {
        const auto is_head = [](char each) {
            return (each >= 'a' && each <= 'z') || (each >= '0' && each <= '9');
        };
        const auto is_rest = [&](char each) {
            return is_head(each) || each == '.' || each == '_' || each == '-';
        };
        return !text.empty()
               && text.size() <= max_feature_tag_size
               && is_head(text.front())
               && std::ranges::all_of(text, is_rest);
    }

private:
    std::array<char, max_feature_tag_size> m_text{};
};

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

// A feature as it declares itself: its id, its tag, the parts it needs and wants, and its settings.
// What it runs is checked where it is wired.
template <typename F>
concept feature_like = std::default_initializable<F> && std::movable<F> && requires {
    requires std::same_as<std::remove_cv_t<decltype(F::id)>, feature_id>;
    requires std::same_as<std::remove_cv_t<decltype(F::tag)>, feature_tag>;
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
