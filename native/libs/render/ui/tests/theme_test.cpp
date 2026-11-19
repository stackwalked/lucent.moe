#include <lucent/ui/theme.hpp>

#include <chrono>
#include <optional>

#include <catch2/catch_test_macros.hpp>

#include <lucent/draw/color.hpp>

namespace lucent::ui {
namespace {

constexpr draw::color accent{.r = 90, .g = 140, .b = 250, .a = 255};

auto inputs_of(theme_preset preset) -> theme_inputs {
    return {
        .accent = accent,
        .preset = preset,
        .scale = 1.0F,
        .is_reduced_motion = false,
        .backdrop = std::nullopt,
        .text_face = {},
        .numeric_face = {},
    };
}

TEST_CASE("reduced motion zeroes every duration, the caret's blink included, but not delays") {
    theme_inputs reduced = inputs_of(theme_preset::dark);
    reduced.is_reduced_motion = true;
    const motion_tokens motion = derive_theme(reduced).motion;
    CHECK(motion.approach_half_life.count() == 0);
    CHECK(motion.spring_response.count() == 0);
    CHECK(motion.fast.count() == 0);
    CHECK(motion.normal.count() == 0);
    CHECK(motion.caret_blink.count() == 0);
    CHECK(motion.tooltip_delay == derive_theme(inputs_of(theme_preset::dark)).motion.tooltip_delay);
}

TEST_CASE("glass over a backdrop near its ink thickens its tint and firms its muted ink") {
    const theme_inputs dark = inputs_of(theme_preset::dark);
    theme_inputs over_snow = dark;
    over_snow.backdrop = draw::color{.r = 240, .g = 240, .b = 240, .a = 255};
    theme_inputs over_night = dark;
    over_night.backdrop = draw::color{.r = 10, .g = 12, .b = 20, .a = 255};

    const theme plain = derive_theme(dark);
    const theme snowy = derive_theme(over_snow);
    CHECK(snowy.materials.glass.tint.a > plain.materials.glass.tint.a);
    CHECK(lightness(snowy.colors.muted_ink) > lightness(plain.colors.muted_ink));
    CHECK(derive_theme(over_night).materials.glass.tint == plain.materials.glass.tint);
}

TEST_CASE("a theme input changing is seen, and the same inputs are not") {
    const theme_inputs dark = inputs_of(theme_preset::dark);
    theme_inputs lit = dark;
    lit.backdrop = draw::white;
    CHECK(is_unchanged(dark, inputs_of(theme_preset::dark)));
    CHECK_FALSE(is_unchanged(dark, lit));
    CHECK_FALSE(is_unchanged(dark, inputs_of(theme_preset::high_contrast)));
}

}
}
