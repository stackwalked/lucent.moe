#include <lucent/menu/catalog.hpp>

#include <optional>
#include <string>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/menu/text_key.hpp>

// A catalog decides every word the menu shows: a lookup that mixed keys up would label one
// feature's switch with another's name, and nothing would crash to say so.

namespace lucent::menu {
namespace {

constexpr kit::feature_id box = kit::feature_key("box");
constexpr kit::feature_id glow = kit::feature_key("glow");
constexpr kit::setting_id color = kit::setting_key("color");

TEST_CASE("a setting's text is its own under each feature, apart from the feature's name") {
    table_catalog text;
    text.add(feature_text{box}, "Box");
    text.add(setting_text{.feature = box, .setting = color}, "Box colour");
    text.add(setting_text{.feature = glow, .setting = color}, "Glow colour");

    CHECK(text_of(text, feature_text{box}) == "Box");
    CHECK(text_of(text, setting_text{.feature = box, .setting = color}) == "Box colour");
    CHECK(text_of(text, setting_text{.feature = glow, .setting = color}) == "Glow colour");
    CHECK_FALSE(text.find(feature_text{glow}).has_value());
}

TEST_CASE("adding a key again replaces its text") {
    table_catalog text;
    text.add(phrase_text{phrases::reset}, "Reset");
    text.add(phrase_text{phrases::reset}, "Zurücksetzen");
    CHECK(
        text.find(phrase_text{phrases::reset}) == std::optional<std::string_view>{"Zurücksetzen"}
    );
}

TEST_CASE("a key the catalog lacks reads as a placeholder made from its own hash") {
    const table_catalog empty;
    const std::string shown = text_of(empty, feature_text{box});
    CHECK(shown == placeholder(feature_text{box}));
    CHECK(shown.size() == 9);
    CHECK(shown.front() == '#');
    CHECK(placeholder(feature_text{glow}) != shown);
}

}
}
