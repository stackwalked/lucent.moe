#pragma once

#include <array>
#include <string>
#include <vector>

#include <lucent/cs2-domains/view.hpp>
#include <lucent/cs2-domains/world.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/draw_context.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>

namespace lucent::cs2::features {

enum class box_coloring : u8 { by_team, single };

struct player_box_settings {
    box_coloring coloring = box_coloring::by_team;
    kit::color terrorists{.r = 234, .g = 190, .b = 84, .a = 255};
    kit::color counter_terrorists{.r = 93, .g = 121, .b = 174, .a = 255};
    kit::color single{.r = 255, .g = 255, .b = 255, .a = 255};
    bool should_show_names = true;
    f32 thickness = 1.0F;

    static constexpr auto describe() -> std::array<kit::setting<player_box_settings>, 6> {
        return {
            kit::choice<"box/coloring", &player_box_settings::coloring, "team", "single">(),
            kit::color_of<"box/terrorists", &player_box_settings::terrorists>(),
            kit::color_of<"box/counter_terrorists", &player_box_settings::counter_terrorists>(),
            kit::color_of<"box/single", &player_box_settings::single>(),
            kit::toggle<"box/names", &player_box_settings::should_show_names>(),
            kit::number<"box/thickness", &player_box_settings::thickness>(
                {.min = 1.0F, .max = 4.0F, .step = 0.5F}
            ),
        };
    }
};

// One player's box on screen, and where its name rests: the middle of the line's bottom edge.
struct player_mark {
    draw::rect box;
    draw::color tint;
    std::string name;
    draw::vec2 name_anchor;
};

// A 2D box around each other player, from their collision bounds, with their name above it.
class player_box final {
public:
    static constexpr kit::feature_id id = kit::feature_id_of<"player_box">;
    using needs = kit::needs<world, view>;
    using wants = kit::wants<>;
    using settings = player_box_settings;

    static auto draw(const kit::draw_context<player_box>& parts) -> void;
};

// The boxes of every other living player whose collision box is wholly in front of the camera and
// partly on the canvas, in the world's order. What draw() draws, as values.
auto marks_of(const kit::draw_context<player_box>& parts) -> std::vector<player_mark>;

}
