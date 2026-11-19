#include "dev_catalog.hpp"

#include <string>
#include <string_view>

#include <lucent/kit/feature.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/menu/text_key.hpp>

#include "../features/dev_sample.hpp"

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

auto add_sample(menu::table_catalog& text) -> void {
    constexpr kit::feature_id sample = features::dev_sample::id;
    constexpr kit::setting_id shape = kit::setting_key("sample/shape");
    const auto setting = [&text](kit::setting_id id, std::string_view name) {
        text.add(menu::setting_text{.feature = sample, .setting = id}, std::string{name});
    };
    const auto option = [&text](kit::setting_id id, std::string_view name) {
        text.add(
            menu::option_text{.feature = sample, .setting = shape, .option = id}, std::string{name}
        );
    };
    text.add(menu::feature_text{sample}, "Dev sample");
    setting(kit::setting_key("sample/outline"), "Outline");
    setting(kit::setting_key("sample/size"), "Size");
    setting(shape, "Shape");
    setting(kit::setting_key("sample/tint"), "Tint");
    option(kit::setting_key("square"), "Square");
    option(kit::setting_key("circle"), "Circle");
    option(kit::setting_key("diamond"), "Diamond");
}

}

auto add_dev_text(menu::table_catalog& text) -> void {
    add_phrases(text);
    add_sample(text);
}

}
