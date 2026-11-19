#include <lucent/cs2-overlay/dev_catalog.hpp>

#include <array>
#include <format>
#include <string>
#include <string_view>
#include <utility>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/cs2-features/player_box.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/menu/text_key.hpp>

namespace lucent::cs2::overlay {
namespace {

auto add_phrases(menu::table_catalog& text) -> void {
    text.add(menu::phrase_text{menu::phrases::search}, "Search");
    text.add(menu::phrase_text{menu::phrases::unavailable}, "Unavailable");
    text.add(menu::phrase_text{menu::phrases::unentitled}, "Not in your plan");
    text.add(menu::phrase_text{menu::phrases::failed}, "Failed");
    text.add(menu::phrase_text{menu::phrases::reset}, "Reset");
    text.add(menu::phrase_text{menu::phrases::lapsed}, "Offline");
    text.add(menu::phrase_text{menu::phrases::bind}, "Bind");
    text.add(menu::phrase_text{menu::phrases::always}, "Always");
    text.add(menu::phrase_text{menu::phrases::hold}, "Hold");
    text.add(menu::phrase_text{menu::phrases::toggle}, "Toggle");
    text.add(menu::phrase_text{menu::phrases::no_key}, "None");
    text.add(menu::phrase_text{menu::phrases::press_key}, "Press a key");
}

struct named_key {
    u8 virtual_key = 0;
    std::string_view name;
};

// Keys whose names aren't their own character; letters and digits are added by range.
constexpr std::array named_keys{
    named_key{.virtual_key = VK_LBUTTON, .name = "Mouse 1"},
    named_key{.virtual_key = VK_RBUTTON, .name = "Mouse 2"},
    named_key{.virtual_key = VK_MBUTTON, .name = "Mouse 3"},
    named_key{.virtual_key = VK_XBUTTON1, .name = "Mouse 4"},
    named_key{.virtual_key = VK_XBUTTON2, .name = "Mouse 5"},
    named_key{.virtual_key = VK_BACK, .name = "Backspace"},
    named_key{.virtual_key = VK_TAB, .name = "Tab"},
    named_key{.virtual_key = VK_RETURN, .name = "Enter"},
    named_key{.virtual_key = VK_SHIFT, .name = "Shift"},
    named_key{.virtual_key = VK_CONTROL, .name = "Ctrl"},
    named_key{.virtual_key = VK_MENU, .name = "Alt"},
    named_key{.virtual_key = VK_CAPITAL, .name = "Caps Lock"},
    named_key{.virtual_key = VK_SPACE, .name = "Space"},
    named_key{.virtual_key = VK_PRIOR, .name = "Page Up"},
    named_key{.virtual_key = VK_NEXT, .name = "Page Down"},
    named_key{.virtual_key = VK_END, .name = "End"},
    named_key{.virtual_key = VK_HOME, .name = "Home"},
    named_key{.virtual_key = VK_LEFT, .name = "Left"},
    named_key{.virtual_key = VK_UP, .name = "Up"},
    named_key{.virtual_key = VK_RIGHT, .name = "Right"},
    named_key{.virtual_key = VK_DOWN, .name = "Down"},
    named_key{.virtual_key = VK_INSERT, .name = "Insert"},
    named_key{.virtual_key = VK_DELETE, .name = "Delete"},
};

auto add_keys(menu::table_catalog& text) -> void {
    const auto add = [&text](u8 virtual_key, std::string name) {
        text.add(menu::key_text{kit::input_key{virtual_key}}, std::move(name));
    };
    for (const named_key& named : named_keys) {
        add(named.virtual_key, std::string{named.name});
    }
    // Virtual-key codes of letters and digits are their ASCII characters.
    for (u8 code = '0'; code <= '9'; ++code) {
        add(code, std::string(1, static_cast<char>(code)));
    }
    for (u8 code = 'A'; code <= 'Z'; ++code) {
        add(code, std::string(1, static_cast<char>(code)));
    }
    for (u8 index = 0; index < 24; ++index) {
        add(narrow<u8>(VK_F1 + index), std::format("F{}", index + 1));
    }
}

auto add_player_box(menu::table_catalog& text) -> void {
    constexpr kit::feature_id box = features::player_box::id;
    constexpr kit::setting_id coloring = kit::setting_key("box/coloring");
    const auto setting = [&text](kit::setting_id id, std::string_view name) {
        text.add(menu::setting_text{.feature = box, .setting = id}, std::string{name});
    };
    const auto option = [&text](kit::setting_id id, std::string_view name) {
        text.add(
            menu::option_text{.feature = box, .setting = coloring, .option = id}, std::string{name}
        );
    };
    text.add(menu::feature_text{box}, "Player box");
    setting(coloring, "Colour");
    setting(kit::setting_key("box/terrorists"), "Terrorists");
    setting(kit::setting_key("box/counter_terrorists"), "Counter-terrorists");
    setting(kit::setting_key("box/single"), "One colour");
    setting(kit::setting_key("box/names"), "Names");
    setting(kit::setting_key("box/thickness"), "Thickness");
    option(kit::setting_key("team"), "By team");
    option(kit::setting_key("single"), "One colour");
}

}

auto add_dev_text(menu::table_catalog& text) -> void {
    add_phrases(text);
    add_keys(text);
    add_player_box(text);
}

}
