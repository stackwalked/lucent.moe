#include <lucent/ui/tooltip.hpp>

#include <optional>
#include <string_view>

#include <lucent/text/text_layout.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {

auto tooltip(context& frame, element_id anchor, std::string_view utf8) -> void {
    const theme& tokens = frame.tokens();
    decoration look = plate_decoration(tokens.materials.plate);
    look.radius = tokens.radii.s;
    look.shadow = tokens.elevation.low;
    frame.tooltip(
        anchor,
        {
            .flow = direction::row,
            .width = bounded(fit(), {.min = 0.0F, .max = tokens.controls.picker_size * 2.0F}),
            .height = fit(),
            .padding = symmetric(tokens.spacing.m, tokens.spacing.s),
            .gap = 0.0F,
            .main = main_align::start,
            .cross = cross_align::center,
            .look = look,
        },
        [&] {
            frame.text({
                .utf8 = utf8,
                .style = tokens.type.caption,
                .ink = tokens.colors.ink,
                .wrap = text::text_wrap::words,
                .overflow = text::text_overflow::visible,
                .max_lines = std::nullopt,
            });
        }
    );
}

}
