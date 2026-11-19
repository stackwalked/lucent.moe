#include <lucent/menu/catalog.hpp>

#include <optional>
#include <string>
#include <string_view>

#include <lucent/menu/text_key.hpp>

namespace lucent::menu {

auto text_of(const catalog& text, const text_key& key) -> std::string {
    const std::optional<std::string_view> found = text.find(key);
    return found ? std::string{*found} : placeholder(key);
}

}
