#include <lucent/ui/dropdown.hpp>

#include <algorithm>
#include <array>
#include <iterator>
#include <optional>
#include <ranges>
#include <string_view>

#include <lucent/core/flags.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

#include "control_look.hpp"
#include "lucent/draw/paint.hpp"

namespace lucent::ui {
namespace {

auto draw_chevron(draw::draw_list& list, const draw::rect& area, draw::color ink) -> void {
    const f32 middle = (area.min.x + area.max.x) / 2.0F;
    const f32 depth = (area.max.x - area.min.x) / 2.0F;
    const f32 top = ((area.min.y + area.max.y) / 2.0F) - (depth / 2.0F);
    const std::array<draw::vec2, 3> outline{
        {
            {.x = area.min.x, .y = top},
            {.x = area.max.x, .y = top},
            {.x = middle, .y = top + depth},
        },
    };
    list.fill_convex(outline, ink);
}

auto option_text(context& frame, std::string_view utf8, draw::color ink) -> void {
    frame.text({
        .utf8 = utf8,
        .style = frame.tokens().type.body,
        .ink = ink,
        .wrap = text::text_wrap::none,
        .overflow = text::text_overflow::ellipsis,
        .max_lines = 1,
    });
}

struct option_list {
    const dropdown_spec* spec = nullptr;
    element_id field{};
    std::optional<isize> chosen;
};

auto declare_options(context& frame, option_list& list) -> void {
    const theme& tokens = frame.tokens();
    const dropdown_spec& spec = *list.spec;
    for (const auto [index, option] : std::views::enumerate(spec.options)) {
        const local_key key = key_from_index(index);
        const element_id id = frame.id_of(key);
        if (frame.focused() == list.field && index == spec.selected) {
            frame.focus(id);
        }
        const interaction hit = frame.interact(id, flags{sense::click, sense::focus});
        if (hit.is_activated) {
            list.chosen = index;
        }
        const bool is_selected = index == spec.selected;
        decoration look = detail::control_look(frame, hit);
        look.fill = draw::solid(composite(
            is_selected ? tokens.colors.raised : draw::with_alpha(tokens.colors.raised, 0),
            tokens.colors.state_layer,
            detail::state_strength(frame, hit)
        ));
        look.radius = tokens.radii.s;
        frame.box(
            key,
            {
                .flow = direction::row,
                .width = grow(),
                .height = fixed(tokens.controls.height),
                .padding = symmetric(tokens.spacing.m, 0.0F),
                .gap = 0.0F,
                .main = main_align::start,
                .cross = cross_align::center,
                .look = look,
            },
            [&] {
                option_text(frame, option, is_selected ? tokens.colors.accent : tokens.colors.ink);
            }
        );
    }
}

}

auto dropdown(context& frame, local_key key, const dropdown_spec& spec) -> std::optional<isize> {
    LUCENT_INVARIANT(spec.selected >= 0 && spec.selected < std::ssize(spec.options));
    const theme& tokens = frame.tokens();
    const input_snapshot& input = frame.input();
    const interaction hit = frame.interact(frame.id_of(key), flags{sense::click, sense::focus});
    const bool is_open = frame.is_popup_open(hit.id);
    // A mouse opens and closes it on the press; a key's activation never holds the button.
    if (hit.is_just_pressed || (hit.is_activated && !hit.is_pressed)) {
        if (is_open) {
            frame.close_popup(hit.id);
        } else {
            frame.open_popup(hit.id);
        }
    }
    isize selected = spec.selected;
    if (hit.is_focused && !is_open) {
        if (has_press(input, key_code::up)) {
            selected = std::max(selected - 1, isize{0});
        }
        if (has_press(input, key_code::down)) {
            selected = std::min(selected + 1, std::ssize(spec.options) - 1);
        }
    }
    const box_style field{
        .flow = direction::row,
        .width = grow(),
        .height = fixed(tokens.controls.height),
        .padding = symmetric(tokens.spacing.m, 0.0F),
        .gap = tokens.spacing.m,
        .main = main_align::space_between,
        .cross = cross_align::center,
        .look = detail::control_look(frame, hit),
    };
    frame.box(key, field, [&] {
        option_text(frame, *std::next(spec.options.begin(), selected), tokens.colors.ink);
        frame.custom(
            ui::key<"chevron">(),
            {
                .flow = direction::row,
                .width = fixed(tokens.controls.chevron),
                .height = fixed(tokens.controls.chevron),
                .gap = 0.0F,
                .main = main_align::start,
                .cross = cross_align::start,
            },
            [ink = tokens.colors.muted_ink](draw::draw_list& list, const draw::rect& area) {
                draw_chevron(list, area, ink);
            }
        );
    });
    option_list options{.spec = &spec, .field = hit.id, .chosen = std::nullopt};
    const plate_material& plate = tokens.materials.plate;
    frame.popup(
        hit.id,
        {
            .flow = direction::column,
            .width = fit(),
            .height = fit(),
            .padding = even(tokens.spacing.s),
            .gap = tokens.spacing.xs,
            .main = main_align::start,
            .cross = cross_align::stretch,
            .look =
                {
                    .fill = draw::solid(plate.fill),
                    .radius = tokens.radii.m,
                    .outline = plate.rim,
                    .outline_width = plate.rim_width,
                    .shadow = plate.shadow,
                },
        },
        [&] { declare_options(frame, options); }
    );
    if (options.chosen) {
        selected = *options.chosen;
        frame.close_popup(hit.id);
        frame.focus(hit.id);
    }
    if (selected == spec.selected) {
        return std::nullopt;
    }
    return selected;
}

}
