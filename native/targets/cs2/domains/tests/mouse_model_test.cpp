#include <lucent/cs2-domains/mouse_model.hpp>

#include <cmath>
#include <optional>
#include <tuple>

#include <catch2/catch_test_macros.hpp>

// A view turned by a fraction of a count, by more than a command can carry, or by counts no
// command ever carries, is a turn no mouse made: silent in play, plain to anyone comparing the
// commands with the view. These check the model against turns worked out by hand.

namespace lucent::cs2 {
namespace {

// Sensitivity 2.5 at m_yaw and m_pitch 0.022: a count right turns yaw down, a count down turns
// pitch up.
constexpr heading origin{.pitch = 0.0F, .yaw = 0.0F};

constexpr count_size size{.pitch = 0.055F, .yaw = -0.055F};

auto is_near(f32 value, f32 expected) -> bool {
    return std::abs(value - expected) <= 0.0001F;
}

}

TEST_CASE("the view turns by whole counts, owes them, and keeps the rest asked for") {
    mouse_model view;
    view.request({.pitch = 0.0F, .yaw = -1.0F});

    const std::optional<heading> turned = view.turn({.pitch = 0.0F, .yaw = 10.0F}, size);

    REQUIRE(turned.has_value());
    const heading result = turned.value_or(origin);
    // 1 / 0.055 is 18.18 counts: 18 turn now.
    CHECK(is_near(result.yaw, 10.0F - (18.0F * 0.055F)));
    CHECK(view.owed() == mouse_counts{.dx = 18, .dy = 0});
    CHECK(is_near(view.pending().yaw, -(1.0F - (18.0F * 0.055F))));
}

TEST_CASE("requests from every feature add up before the view turns") {
    mouse_model view;
    view.request({.pitch = 0.55F, .yaw = 0.0F});
    view.request({.pitch = 0.55F, .yaw = 0.0F});

    const std::optional<heading> turned = view.turn(origin, size);

    REQUIRE(turned.has_value());
    CHECK(view.owed() == mouse_counts{.dx = 0, .dy = 20});
}

TEST_CASE("no more counts are owed than one command carries, until a command takes them") {
    mouse_model view;
    view.request({.pitch = 0.0F, .yaw = 180.0F});

    std::ignore = view.turn(origin, size);
    CHECK(view.owed().dx == -counts_per_command);
    CHECK_FALSE(view.turn(origin, size));

    CHECK(view.settle() == mouse_counts{.dx = -counts_per_command, .dy = 0});
    CHECK(view.owed() == mouse_counts{});
    REQUIRE(view.turn(origin, size));
    CHECK(view.owed().dx == -counts_per_command);
}

TEST_CASE("less than half a count turns nothing and owes nothing") {
    mouse_model view;
    view.request({.pitch = 0.02F, .yaw = 0.02F});

    CHECK_FALSE(view.turn(origin, size));
    CHECK(view.owed() == mouse_counts{});
}

TEST_CASE("pitch stops at the game's limit, with only the counts that fit owed") {
    mouse_model view;
    view.request({.pitch = 5.0F, .yaw = 0.0F});

    const std::optional<heading> turned = view.turn({.pitch = 88.0F, .yaw = 0.0F}, size);

    REQUIRE(turned.has_value());
    const heading result = turned.value_or(origin);
    CHECK(result.pitch <= pitch_limit);
    // 18 counts are 0.99 degrees; a 19th would pass 89.
    CHECK(view.owed().dy == 18);
}

TEST_CASE("yaw wraps around the half turn") {
    mouse_model view;
    view.request({.pitch = 0.0F, .yaw = 1.1F});

    const std::optional<heading> turned = view.turn({.pitch = 0.0F, .yaw = 179.5F}, size);

    REQUIRE(turned.has_value());
    const heading result = turned.value_or(origin);
    CHECK(is_near(result.yaw, 179.5F + 1.1F - 360.0F));
}

TEST_CASE("forgetting drops what was asked and what was owed") {
    mouse_model view;
    view.request({.pitch = 1.0F, .yaw = 1.0F});
    std::ignore = view.turn(origin, size);

    view.forget();

    CHECK(view.pending().pitch == 0.0F);
    CHECK(view.pending().yaw == 0.0F);
    CHECK(view.owed() == mouse_counts{});
}

}
