#pragma once

#include <optional>
#include <string>

#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/bind.hpp>
#include <lucent/kit/config_store.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/menu/catalog.hpp>
#include <lucent/menu/page.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::menu {

struct menu_frame {
    ui::input_snapshot input;
    // In units.
    draw::vec2 viewport;
    f32 pixels_per_unit = 1.0F;
};

struct menu_appearance {
    ui::theme tokens;
    // Not null.
    const catalog* text = nullptr;
};

auto menu_theme(text::face_id face, ui::theme_preset preset) -> ui::theme;

// The generated settings page in a window over the game: what it shows comes from the registry's
// published snapshot, and its edits go back as requests the next safe point applies: through the
// config store, which keeps them in the active profile and its undo, when it has one.
//
// Threads: the presenting thread only, like the text system it borrows, which must outlive it, as
// must the catalog, the registry and the config store (whose thread this is).
class settings_menu final {
public:
    // Edits go to the registry alone: kept in no profile.
    settings_menu(text::text_system& text, menu_appearance appearance, kit::registry& features);
    settings_menu(text::text_system& text, menu_appearance appearance, kit::config_store& configs);

    // Before draw(): this frame's keys and mouse buttons, which a bind waiting for its key takes.
    auto take_keys(kit::key_input keys) -> void;

    // Lays out and records one frame of the menu into list.
    auto draw(menu_frame frame, draw::draw_list& list) -> result<ui::frame_report>;

private:
    auto declare(draw::vec2 viewport) -> page_outcome;

    ui::context m_ui;
    ui::theme m_tokens;
    const catalog* m_text;
    kit::registry* m_features;
    // Null when edits go to the registry alone.
    kit::config_store* m_configs = nullptr;
    // The search field's text and the bind waiting for a key, which the page hands back each
    // frame.
    std::string m_query;
    std::optional<kit::feature_id> m_binding;
    kit::key_input m_keys;
};

}
