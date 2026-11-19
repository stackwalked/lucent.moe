#pragma once

#include <optional>
#include <string>
#include <string_view>

#include <lucent/menu/text_key.hpp>

namespace lucent::menu {

// The menu's text, by key. A dev build fills one from the dev names; a release receives one per
// session from the server.
class catalog {
public:
    catalog(const catalog&) = delete ("the menu borrows a catalog");
    auto operator=(const catalog&) -> catalog& = delete ("the menu borrows a catalog");
    catalog(catalog&&) = delete ("the menu borrows a catalog");
    auto operator=(catalog&&) -> catalog& = delete ("the menu borrows a catalog");
    virtual ~catalog() = default;

    // The view lives as long as the catalog does.
    virtual auto find(const text_key& key) const -> std::optional<std::string_view> = 0;

protected:
    catalog() = default;
};

// What key reads as: its entry, or its placeholder when the catalog has none.
auto text_of(const catalog& text, const text_key& key) -> std::string;

}
