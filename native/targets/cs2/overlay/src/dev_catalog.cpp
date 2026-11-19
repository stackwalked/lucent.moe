#include <lucent/cs2-overlay/dev_catalog.hpp>

#include <string>
#include <string_view>

#include <lucent/cs2-features/player_box.hpp>
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
    text.add(menu::phrase_text{menu::phrases::red}, "Red");
    text.add(menu::phrase_text{menu::phrases::green}, "Green");
    text.add(menu::phrase_text{menu::phrases::blue}, "Blue");
    text.add(menu::phrase_text{menu::phrases::alpha}, "Alpha");
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
    add_player_box(text);
}

}
