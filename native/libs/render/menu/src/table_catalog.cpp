#include <lucent/menu/table_catalog.hpp>

#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <lucent/menu/text_key.hpp>

namespace lucent::menu {

auto table_catalog::add(const text_key& key, std::string utf8) -> void {
    m_entries.insert_or_assign(key, std::move(utf8));
}

auto table_catalog::find(const text_key& key) const -> std::optional<std::string_view> {
    const auto found = m_entries.find(key);
    if (found == m_entries.end()) {
        return std::nullopt;
    }
    return std::string_view{found->second};
}

}
