#pragma once

#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/kit/feature.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/settings.hpp>
#include <lucent/menu/catalog.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::menu {

// What one frame of the settings page is generated from. Everything is borrowed for the call.
struct page_input {
    // The registry's published snapshot: the only state the page reads, settings' descriptions
    // included. Not null.
    const kit::registry_snapshot* snapshot = nullptr;
    // Not null.
    const catalog* text = nullptr;
    // The search field's text: rows whose label holds it (ignoring ASCII case) are shown.
    std::string_view query;
};

struct page_outcome {
    // One batch for registry::request(), empty when nothing was edited. The page goes on showing
    // the snapshot it was given until the registry publishes the edit.
    std::vector<kit::registry_change> changes;
    // The search field's text after this frame's typing.
    std::string query;
};

// The generated settings page: a search field, then each feature the snapshot lists, in wiring
// order, with its state and its settings as controls.
auto settings_page(ui::context& frame, ui::local_key key, const page_input& input) -> page_outcome;

// The ids of the page's parts, given the page's own id: what the glue focuses and tests find.

constexpr auto search_field_id(ui::element_id page) -> ui::element_id {
    return ui::child_id(page, ui::key<"search">());
}

constexpr auto feature_id_in(ui::element_id page, kit::feature_id feature) -> ui::element_id {
    return ui::child_id(page, ui::local_key{std::to_underlying(feature)});
}

// The on/off switch of a feature that is on or off; no other state has one.
constexpr auto feature_switch_id(ui::element_id page, kit::feature_id feature) -> ui::element_id {
    return ui::child_id(feature_id_in(page, feature), ui::key<"switch">());
}

// The row showing why a feature can't be switched: unavailable, unentitled or failed.
constexpr auto feature_status_id(ui::element_id page, kit::feature_id feature) -> ui::element_id {
    return ui::child_id(feature_id_in(page, feature), ui::key<"status">());
}

// A failed feature's reset button.
constexpr auto reset_button_id(ui::element_id page, kit::feature_id feature) -> ui::element_id {
    return ui::child_id(feature_status_id(page, feature), ui::key<"reset">());
}

struct setting_place {
    kit::feature_id feature{};
    kit::setting_id setting{};
};

constexpr auto setting_row_id(ui::element_id page, setting_place place) -> ui::element_id {
    return ui::child_id(
        feature_id_in(page, place.feature), ui::local_key{std::to_underlying(place.setting)}
    );
}

// The setting's control: a toggle row, a slider, a dropdown field or a colour swatch.
constexpr auto setting_control_id(ui::element_id page, setting_place place) -> ui::element_id {
    return ui::child_id(setting_row_id(page, place), ui::key<"control">());
}

}
