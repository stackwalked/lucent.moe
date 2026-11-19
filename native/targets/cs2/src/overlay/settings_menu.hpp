#pragma once

#include <string>

#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/menu/page.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/input_snapshot.hpp>
#include <lucent/ui/theme.hpp>

namespace lucent::cs2::overlay {

struct menu_frame {
    ui::input_snapshot input;
    // In units.
    draw::vec2 viewport;
};

// The generated settings page in a window over the game: what it shows comes from the registry's
// published snapshot, and its edits go back as requests the next safe point applies.
//
// Threads: the presenting thread only, like the text system it borrows, which must outlive it, as
// must the registry.
class settings_menu final {
public:
    settings_menu(text::text_system& text, text::face_id face, kit::registry& features);

    // Lays out and records one frame of the menu into list.
    auto draw(menu_frame frame, draw::draw_list& list) -> result<ui::frame_report>;

private:
    auto declare(draw::vec2 viewport) -> menu::page_outcome;

    ui::context m_ui;
    ui::theme m_tokens;
    // Filled from the dev names in a dev build; empty in a release until the server delivers the
    // session's catalog, so every label is its placeholder.
    menu::table_catalog m_text;
    kit::registry* m_features;
    // The search field's text, which the page hands back each frame.
    std::string m_query;
};

}
