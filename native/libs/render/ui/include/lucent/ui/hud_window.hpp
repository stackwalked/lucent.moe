#pragma once

#include <flat_map>
#include <string_view>

#include <lucent/core/stdx/function_ref.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/ui/box_style.hpp>
#include <lucent/ui/context.hpp>
#include <lucent/ui/element_id.hpp>

namespace lucent::ui {

// Where HUD windows the user moved sit, by key, in units from the viewport's top left. Its owner
// keeps it; a window not in it sits where its spec says.
struct hud_placements {
    std::flat_map<local_key, draw::vec2> positions;
};

enum class hud_mode : u8 {
    // Shown over the game: input passes through it.
    locked,
    // While the menu is open: its title bar drags it, kept inside the viewport.
    arranging,
};

struct hud_window_spec {
    local_key key{};
    std::string_view title;
    // Where it sits until it is moved.
    draw::vec2 position;
    size_rule width = fit();
    hud_mode mode = hud_mode::locked;
};

// A window on the plate material, for what a feature shows over the game: a title bar, then the
// children in a column. Its id is root_id(spec.key); its title bar's is hud_title_id() of that.
auto hud_window(
    context& frame,
    hud_placements& placements,
    const hud_window_spec& spec,
    stdx::function_ref<void()> children
) -> void;

constexpr auto hud_title_id(element_id window) -> element_id {
    return child_id(window, key<"title">());
}

}
