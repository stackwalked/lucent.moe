#pragma once

#include <optional>
#include <string_view>

#include <lucent/draw/color.hpp>
#include <lucent/text/text_layout.hpp>

namespace lucent::ui {

// A text leaf. Its width is the unwrapped text's unless its parent has less room; it is wrapped or
// cut at its final width, which sets its height. The UTF-8 is copied when declared.
struct text_spec {
    std::string_view utf8;
    text::text_style style;
    draw::color ink;
    text::text_wrap wrap = text::text_wrap::none;
    text::text_overflow overflow = text::text_overflow::visible;
    std::optional<isize> max_lines;
};

}
