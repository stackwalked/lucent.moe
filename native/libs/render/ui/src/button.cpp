#include <lucent/ui/button.hpp>

#include <string_view>

#include <lucent/core/flags.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/interaction.hpp>
#include <lucent/ui/theme.hpp>

#include "control_look.hpp"

namespace lucent::ui {

auto button(context& frame, local_key key, std::string_view caption) -> interaction {
    const theme& tokens = frame.tokens();
    const interaction hit = frame.interact(frame.id_of(key), flags{sense::click, sense::focus});
    const box_style style{
        .flow = direction::row,
        .width = fit(),
        .height = fixed(tokens.controls.height),
        .padding = symmetric(tokens.spacing.l, 0.0F),
        .gap = 0.0F,
        .main = main_align::center,
        .cross = cross_align::center,
        .look = detail::control_look(frame, hit),
    };
    frame.box(key, style, [&] {
        frame.text({
            .utf8 = caption,
            .style = tokens.type.body,
            .ink = tokens.colors.ink,
            .wrap = text::text_wrap::none,
            .overflow = text::text_overflow::ellipsis,
            .max_lines = 1,
        });
    });
    return hit;
}

}
