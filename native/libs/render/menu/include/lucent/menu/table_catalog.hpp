#pragma once

#include <flat_map>
#include <optional>
#include <string>
#include <string_view>

#include <lucent/menu/catalog.hpp>
#include <lucent/menu/text_key.hpp>

namespace lucent::menu {

// A catalog held in memory, filled entry by entry.
class table_catalog final : public catalog {
public:
    table_catalog() = default;

    // Replaces the key's entry if it has one.
    auto add(const text_key& key, std::string utf8) -> void;

    auto find(const text_key& key) const -> std::optional<std::string_view> override;

private:
    std::flat_map<text_key, std::string> m_entries;
};

}
