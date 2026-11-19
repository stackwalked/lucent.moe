#include <lucent/ui/hud_window.hpp>

#include <algorithm>
#include <optional>

#include <lucent/core/flags.hpp>
#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {
namespace {

// The whole window inside the viewport, as far as it fits.
auto kept_inside(draw::vec2 position, draw::vec2 size, draw::vec2 viewport) -> draw::vec2 {
    return {
        .x = std::clamp(position.x, 0.0F, std::max(viewport.x - size.x, 0.0F)),
        .y = std::clamp(position.y, 0.0F, std::max(viewport.y - size.y, 0.0F)),
    };
}

// Where a press on the title bar holding the window puts it, keeping where the bar was taken;
// absent while nothing holds it.
auto dragged_position(context& frame, element_id window, draw::vec2 position)
    -> std::optional<draw::vec2> {
    const element_id title = hud_title_id(window);
    const interaction hit = frame.interact(title, flags{sense::drag});
    const element_id grab_x = child_id(title, key<"grab x">());
    const element_id grab_y = child_id(title, key<"grab y">());
    if (!hit.cursor || !hit.is_pressed) {
        return std::nullopt;
    }
    if (hit.is_just_pressed) {
        frame.keep(grab_x, hit.cursor->x - position.x);
        frame.keep(grab_y, hit.cursor->y - position.y);
    }
    const draw::vec2 grab{
        .x = frame.kept(grab_x).value_or(0.0F),
        .y = frame.kept(grab_y).value_or(0.0F),
    };
    frame.keep(grab_x, grab.x);
    frame.keep(grab_y, grab.y);
    return *hit.cursor - grab;
}

}

auto hud_window(
    context& frame,
    hud_placements& placements,
    const hud_window_spec& spec,
    stdx::function_ref<void()> children
) -> void {
    const theme& tokens = frame.tokens();
    const element_id window = root_id(spec.key);
    const auto placed = placements.positions.find(spec.key);
    draw::vec2 position = placed != placements.positions.end() ? placed->second : spec.position;
    const bool is_arranging = spec.mode == hud_mode::arranging;
    if (is_arranging) {
        if (const std::optional<draw::vec2> moved = dragged_position(frame, window, position)) {
            const std::optional<draw::rect> last = frame.rect(window);
            const draw::vec2 size = last ? last->max - last->min : draw::vec2{.x = 0.0F, .y = 0.0F};
            position = kept_inside(*moved, size, frame.viewport());
            placements.positions.insert_or_assign(spec.key, position);
        }
    }
    decoration look = plate_decoration(tokens.materials.plate);
    if (is_arranging) {
        look.outline = tokens.colors.accent;
        look.outline_width = tokens.controls.focus_width;
    }
    const window_spec declared{
        .key = spec.key,
        .position = position,
        .style =
            {
                .flow = direction::column,
                .width = spec.width,
                .height = fit(),
                .padding = symmetric(tokens.spacing.m, tokens.spacing.s),
                .gap = tokens.spacing.xs,
                .main = main_align::start,
                .cross = cross_align::stretch,
                .look = look,
            },
        .input = is_arranging ? input_policy::taken : input_policy::passed,
    };
    frame.window(declared, [&] {
        frame.box(
            key<"title">(),
            {
                .flow = direction::row,
                .width = grow(),
                .height = fixed(tokens.controls.title_height),
                .gap = tokens.spacing.s,
                .main = main_align::space_between,
                .cross = cross_align::center,
            },
            [&] {
                frame.text({
                    .utf8 = spec.title,
                    .style = tokens.type.caption,
                    .ink = tokens.colors.muted_ink,
                    .wrap = text::text_wrap::none,
                    .overflow = text::text_overflow::ellipsis,
                    .max_lines = 1,
                });
            }
        );
        children();
    });
}

}
