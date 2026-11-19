#include <lucent/cs2-overlay/input_feed.hpp>

#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/bind.hpp>

// The presenting thread looks at the keys once a frame, so a toggle tapped twice between frames,
// or a hold let go and pressed again, would be misread silently: the bind just does the wrong
// thing in a game.

namespace lucent::cs2::overlay {
namespace {

constexpr kit::input_key f_key{0x46};
constexpr kit::input_key g_key{0x47};
constexpr key_tally untouched{};

auto down(kit::input_key key) -> kit::key_change {
    return {.key = key, .is_down = true};
}

auto up(kit::input_key key) -> kit::key_change {
    return {.key = key, .is_down = false};
}

enum class ending : u8 { up, down };

// The tally after presses more of key, which is left up or down.
auto pressed(key_tally keys, kit::input_key key, u32 presses, ending last) -> key_tally {
    keys.presses.at(std::to_underlying(key)) += presses;
    keys.is_down.at(std::to_underlying(key)) = last == ending::down;
    return keys;
}

}

TEST_CASE("nothing changed between looks is no key change") {
    const key_tally held = pressed(untouched, f_key, 1, ending::down);
    CHECK(key_input_of(held, held).changes.empty());
}

TEST_CASE("a press and a release between looks reach binds as both") {
    const key_tally before{};
    CHECK(
        key_input_of(pressed(before, f_key, 1, ending::up), before).changes
        == std::vector{down(f_key), up(f_key)}
    );
    CHECK(
        key_input_of(pressed(before, f_key, 1, ending::down), before).changes
        == std::vector{down(f_key)}
    );
    const key_tally held = pressed(before, f_key, 1, ending::down);
    CHECK(
        key_input_of(pressed(held, f_key, 0, ending::up), held).changes == std::vector{up(f_key)}
    );
}

TEST_CASE("presses between looks keep their count's parity, so a toggle ends where it should") {
    const key_tally held = pressed(untouched, f_key, 1, ending::down);
    CHECK(
        key_input_of(pressed(held, f_key, 2, ending::down), held).changes
        == std::vector{up(f_key), down(f_key), up(f_key), down(f_key)}
    );
    CHECK(
        key_input_of(pressed(held, f_key, 5, ending::up), held).changes
        == std::vector{up(f_key), down(f_key), up(f_key)}
    );
}

TEST_CASE("a press count that wrapped around still counts the presses since") {
    key_tally before{};
    before.presses.at(std::to_underlying(g_key)) = 0xffff'ffffU;
    const key_tally after = pressed(before, g_key, 1, ending::down);
    CHECK(after.presses.at(std::to_underlying(g_key)) == 0);
    CHECK(key_input_of(after, before).changes == std::vector{down(g_key)});
}

TEST_CASE("while the menu has the keys, binds get only the releases") {
    const kit::key_input keys{.changes = {down(f_key), up(g_key), up(f_key)}};
    CHECK(releases_of(keys).changes == std::vector{up(g_key), up(f_key)});
}

}
