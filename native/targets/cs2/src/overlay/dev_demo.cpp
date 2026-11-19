#include "dev_demo.hpp"

#include <optional>
#include <string_view>

#include <lucent/draw/circle.hpp>
#include <lucent/draw/color.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/paint.hpp>
#include <lucent/draw/rect.hpp>
#include <lucent/draw/rounded_rect.hpp>
#include <lucent/draw/stroke_style.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>

namespace lucent::cs2::overlay {
namespace {

// Latin and Greek on the fast path's face, Arabic joined and laid right to left, Japanese from a
// face the system's fallback finds: shaping, bidi, fallback and the atlas, in one line.
constexpr std::string_view demo_line = "lucent overlay — Ελληνι"
                                       "κά, العربية, "
                                       "日本語";

constexpr draw::vec2 plate_origin{.x = 24.0F, .y = 24.0F};
constexpr f32 plate_padding = 12.0F;
constexpr f32 text_size = 20.0F;
constexpr draw::color plate_color{.r = 16, .g = 18, .b = 24, .a = 200};
constexpr draw::color edge_color{.r = 255, .g = 255, .b = 255, .a = 40};
constexpr draw::color accent{.r = 255, .g = 0, .b = 153, .a = 255};

}

dev_demo::dev_demo(text::face_id face)
    : m_face{face} {}

auto dev_demo::draw(text::text_system& text, draw::draw_list& list) const -> result<void> {
    const text::text_layout* const line = LUCENT_TRY(text.layout({
        .utf8 = demo_line,
        .style = {.face = m_face, .size = text_size},
        .max_width = 0.0F,
        .wrap = text::text_wrap::none,
        .overflow = text::text_overflow::visible,
        .max_lines = std::nullopt,
        .pixels_per_unit = 1.0F,
    }));
    const draw::vec2 text_origin =
        plate_origin + draw::vec2{.x = plate_padding, .y = plate_padding};
    const draw::rounded_rect plate{
        .bounds =
            {
                .min = plate_origin,
                .max =
                    text_origin + line->size + draw::vec2{.x = plate_padding, .y = plate_padding},
            },
        .radii = draw::uniform(8.0F),
    };
    list.fill(plate, draw::solid(plate_color));
    list.stroke(plate, draw::solid(edge_color), draw::stroke_style{});
    const f32 middle = (plate.bounds.min.y + plate.bounds.max.y) / 2.0F;
    const draw::circle dot{
        .centre = {.x = plate.bounds.max.x + 20.0F, .y = middle},
        .radius = 8.0F,
    };
    list.fill(dot, draw::solid(accent));
    return text.draw(list, *line, text_origin, draw::white);
}

}
