#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace lucent::ui {

// The system's clipboard, as the glue provides it: text fields copy to it and paste from it.
// Threads: the one the UI runs on.
class clipboard {
public:
    clipboard(const clipboard&) = delete ("the UI borrows a clipboard");
    auto operator=(const clipboard&) -> clipboard& = delete ("the UI borrows a clipboard");
    clipboard(clipboard&&) = delete ("the UI borrows a clipboard");
    auto operator=(clipboard&&) -> clipboard& = delete ("the UI borrows a clipboard");
    virtual ~clipboard() = default;

    // UTF-8; absent when it holds no text, or another program holds it open.
    virtual auto text() const -> std::optional<std::string> = 0;
    // Replaces what it holds. Lost when another program holds it open.
    virtual auto put_text(std::string_view utf8) -> void = 0;

protected:
    clipboard() = default;
};

}
