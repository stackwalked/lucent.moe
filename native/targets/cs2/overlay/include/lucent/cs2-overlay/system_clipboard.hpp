#pragma once

#include <optional>
#include <string>
#include <string_view>

#include <lucent/ui/clipboard.hpp>

namespace lucent::cs2::overlay {

// Windows' clipboard as Unicode text. Each call opens and closes it at once and never waits: while
// another program holds it open, it reads as empty and takes nothing.
class system_clipboard final : public ui::clipboard {
public:
    system_clipboard() = default;

    auto text() const -> std::optional<std::string> override;
    auto put_text(std::string_view utf8) -> void override;
};

}
