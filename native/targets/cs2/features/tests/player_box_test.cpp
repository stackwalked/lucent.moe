#include <lucent/cs2-features/player_box.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/cs2-domains/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/canvas.hpp>
#include <lucent/kit/draw_context.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/kit/view_set.hpp>

// A box in the wrong place, around the wrong players or in the wrong colour is silent: nothing
// fails, the member just sees a lie. The geometry is checked here against a camera simple enough
// to work out by hand.

namespace lucent::cs2::features {
namespace {

constexpr draw::vec2 screen{.x = 1000.0F, .y = 1000.0F};
constexpr f32 tolerance = 0.01F;

auto is_near(f32 value, f32 expected) -> bool {
    return std::abs(value - expected) <= tolerance;
}

// Looking down +x from the origin: depth is x, right is -y, up is z, a 90-degree field of view.
using row = std::array<f32, 4>;

constexpr view camera{
    .to_clip = {
        row{0.0F, -1.0F, 0.0F, 0.0F},
        row{0.0F, 0.0F, 1.0F, 0.0F},
        row{0.0F, 0.0F, 0.0F, 0.0F},
        row{1.0F, 0.0F, 0.0F, 0.0F},
    },
};

auto standing_at(vec3 origin, team side) -> player {
    return player{
        .controller = entity_handle{1},
        .pawn = entity_handle{100},
        .name = "bravo",
        .side = side,
        .health = 100,
        .is_alive = true,
        .is_local = false,
        .origin = origin,
        .mins = {.x = -16.0F, .y = -16.0F, .z = 0.0F},
        .maxs = {.x = 16.0F, .y = 16.0F, .z = 72.0F},
    };
}

// The player 100 units ahead whose box the comments work out: corners at depth 84 and 116, y
// +-16, z from -50 to 22.
auto ahead(team side) -> player {
    return standing_at({.x = 100.0F, .y = 0.0F, .z = -50.0F}, side);
}

// One frame's parts, settings and canvas, as the registry hands them to the feature.
class frame final {
public:
    frame(world players, player_box_settings chosen)
        : m_players{std::move(players)}
        , m_settings{chosen}
        , m_canvas{m_list, screen} {
        m_list.reset({.size = {.width = 1000, .height = 1000}, .pixels_per_unit = 1.0F});
        m_parts.put(m_players);
        m_parts.put(camera);
    }

    frame(const frame&) = delete ("the parts point into it");
    auto operator=(const frame&) -> frame& = delete ("the parts point into it");
    frame(frame&&) = delete ("the parts point into it");
    auto operator=(frame&&) -> frame& = delete ("the parts point into it");
    ~frame() = default;

    auto context() -> kit::draw_context<player_box> {
        return kit::draw_context<player_box>{m_parts, m_settings, m_canvas};
    }

    auto onto() const -> const kit::canvas& {
        return m_canvas;
    }

private:
    world m_players;
    player_box_settings m_settings;
    draw::draw_list m_list;
    kit::canvas m_canvas;
    kit::view_set m_parts;
};

auto every_team() -> world {
    return world{
        .players = {ahead(team::terrorists), ahead(team::counter_terrorists), ahead(team::none)},
    };
}

auto as_draw(kit::color chosen) -> draw::color {
    return {.r = chosen.r, .g = chosen.g, .b = chosen.b, .a = chosen.a};
}

auto marks_for(world players, player_box_settings chosen) -> std::vector<player_mark> {
    frame drawn{std::move(players), chosen};
    return marks_of(drawn.context());
}

}

TEST_CASE("a box spans the projected collision bounds, with the name resting just above it") {
    const std::vector<player_mark> marks = marks_for({.players = {ahead(team::terrorists)}}, {});

    REQUIRE(marks.size() == 1);
    const player_mark& mark = marks.front();
    // x: 500 * (1 - y / depth) at y = +-16, depth 84. y: 500 * (1 - z / depth) at z = 22 and -50.
    CHECK(is_near(mark.box.min.x, 404.7619F));
    CHECK(is_near(mark.box.max.x, 595.2381F));
    CHECK(is_near(mark.box.min.y, 369.0476F));
    CHECK(is_near(mark.box.max.y, 797.6190F));
    CHECK(mark.name == "bravo");
    CHECK(is_near(mark.name_anchor.x, 500.0F));
    CHECK(is_near(mark.name_anchor.y, 366.0476F));
}

TEST_CASE("the local player, the dead, and anyone behind the camera or off screen get no box") {
    player local = ahead(team::terrorists);
    local.is_local = true;
    player dead = ahead(team::terrorists);
    dead.is_alive = false;
    const player behind = standing_at({.x = -100.0F, .y = 0.0F, .z = 0.0F}, team::terrorists);
    // Straddling the camera plane: one corner in front, one behind.
    const player beside = standing_at({.x = 0.0F, .y = 100.0F, .z = 0.0F}, team::terrorists);
    const player far_left = standing_at({.x = 100.0F, .y = 1000.0F, .z = 0.0F}, team::terrorists);

    const std::vector<player_mark> marks =
        marks_for({.players = {local, dead, behind, beside, far_left}}, {});

    CHECK(marks.empty());
}

TEST_CASE("a box takes its team's colour, and a player of no team the one colour") {
    const player_box_settings by_team;

    const std::vector<player_mark> marks = marks_for(every_team(), by_team);

    REQUIRE(marks.size() == 3);
    CHECK(marks.at(0).tint == as_draw(by_team.terrorists));
    CHECK(marks.at(1).tint == as_draw(by_team.counter_terrorists));
    CHECK(marks.at(2).tint == as_draw(by_team.single));
}

TEST_CASE("with one colour chosen, every box takes it whatever the team") {
    player_box_settings single;
    single.coloring = box_coloring::single;

    const std::vector<player_mark> marks = marks_for(every_team(), single);

    REQUIRE(marks.size() == 3);
    CHECK(std::ranges::all_of(marks, [&single](const player_mark& mark) {
        return mark.tint == as_draw(single.single);
    }));
}

TEST_CASE("drawing labels each box with its player's name, and labels nothing with names off") {
    const world players{.players = {ahead(team::terrorists)}};
    frame named{players, {}};
    player_box_settings without_names;
    without_names.should_show_names = false;
    frame unnamed{players, without_names};

    player_box::draw(named.context());
    player_box::draw(unnamed.context());

    REQUIRE(named.onto().labels().size() == 1);
    const kit::label& label = named.onto().labels().front();
    CHECK(label.text == "bravo");
    CHECK(is_near(label.anchor.x, 500.0F));
    CHECK(is_near(label.anchor.y, 366.0476F));
    CHECK(unnamed.onto().labels().empty());
}

}
