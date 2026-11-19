#include <lucent/ui/label.hpp>

#include <optional>
#include <string_view>

#include <lucent/text/text_layout.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::ui {

auto label(context& frame, std::string_view utf8) -> void {
    const theme& tokens = frame.tokens();
    frame.text({
        .utf8 = utf8,
        .style = tokens.type.body,
        .ink = tokens.colors.ink,
        .wrap = text::text_wrap::words,
        .overflow = text::text_overflow::visible,
        .max_lines = std::nullopt,
    });
}

}
