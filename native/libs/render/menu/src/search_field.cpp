#include "search_field.hpp"

#include <optional>
#include <string>
#include <string_view>

#include <lucent/core/flags.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::menu::detail {
namespace {

auto is_continuation(char unit) -> bool {
    return (static_cast<u8>(unit) & 0xc0U) == 0x80U;
}

auto is_control(char unit) -> bool {
    return static_cast<u8>(unit) < 0x20U || static_cast<u8>(unit) == 0x7fU;
}

// text without its last code point, whatever that one's length.
auto without_last(std::string_view text) -> std::string_view {
    while (!text.empty() && is_continuation(text.back())) {
        text.remove_suffix(1);
    }
    if (!text.empty()) {
        text.remove_suffix(1);
    }
    return text;
}

}

auto edited(std::string_view query, const ui::input_snapshot& input) -> std::string {
    std::string_view kept = query;
    for (const ui::key_event& event : input.keys) {
        if (event.code == ui::key_code::backspace && event.action != ui::key_action::released) {
            kept = without_last(kept);
        }
    }
    std::string result{kept};
    for (const char unit : input.text) {
        if (!is_control(unit)) {
            result.push_back(unit);
        }
    }
    return result;
}

auto search_field(ui::context& frame, ui::local_key key, const search_field_spec& spec)
    -> std::string {
    const ui::theme& tokens = frame.tokens();
    const ui::interaction hit =
        frame.interact(frame.id_of(key), flags{ui::sense::click, ui::sense::focus});
    std::string query{spec.query};
    if (hit.is_focused) {
        query = edited(spec.query, frame.input());
    }
    const bool is_empty = query.empty();
    const ui::box_style field{
        .flow = ui::direction::row,
        .width = ui::grow(),
        .height = ui::fixed(tokens.controls.height),
        .padding = ui::symmetric(tokens.spacing.m, 0.0F),
        .gap = 0.0F,
        .main = ui::main_align::start,
        .cross = ui::cross_align::center,
        .look = {
            .fill = draw::solid(tokens.colors.sunken),
            .radius = tokens.radii.m,
            .outline = hit.is_focused ? tokens.colors.focus : draw::transparent,
            .outline_width = tokens.controls.focus_width,
            .shadow = std::nullopt,
        },
    };
    frame.box(key, field, [&] {
        frame.text({
            .utf8 = is_empty ? spec.hint : std::string_view{query},
            .style = tokens.type.body,
            .ink = is_empty ? tokens.colors.muted_ink : tokens.colors.ink,
            .wrap = text::text_wrap::none,
            .overflow = text::text_overflow::ellipsis,
            .max_lines = 1,
        });
    });
    return query;
}

}
