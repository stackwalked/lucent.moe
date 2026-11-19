#pragma once

#include <chrono>
#include <memory>
#include <optional>

#include <d3d11.h>
#include <dxgi.h>

#include <lucent/cs2-domains/world_domain.hpp>
#include <lucent/cs2-overlay/overlay_state.hpp>
#include <lucent/cs2-overlay/system_clipboard.hpp>
#include <lucent/cs2-overlay/window_input.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/config_store.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/menu/settings_menu.hpp>
#include <lucent/menu/table_catalog.hpp>
#include <lucent/text/text_system.hpp>

#include "dev_demo.hpp"
#include "dev_stats.hpp"
#include "renderer_build.hpp"

namespace lucent::cs2::overlay {

// What the overlay borrows: each outlives it, and none is null.
struct overlay_parts {
    kit::worker_set* workers = nullptr;
    kit::registry* features = nullptr;
    // Over features: the menu edits through it.
    kit::config_store* configs = nullptr;
    world_domain* world = nullptr;
    const kit::clock* time = nullptr;
};

// What the module draws over the game's frames, and everything it draws them with.
//
// Threads: made and dropped on the lifecycle thread while the present hook is not installed; in
// between, draw() runs on whatever thread presents, and past the choice of swap chain only on the
// one presenting the game's window, which is the registry's tick thread and the world domain's
// update thread for now. The game window's thread runs its subclassed procedure.
class overlay final {
public:
    explicit overlay(overlay_parts parts);
    overlay(const overlay&) = delete ("the present hook holds its address");
    auto operator=(const overlay&) -> overlay& = delete ("the present hook holds its address");
    overlay(overlay&&) = delete ("the present hook holds its address");
    auto operator=(overlay&&) -> overlay& = delete ("the present hook holds its address");
    ~overlay();

    // Draws over the frame about to be presented on swap_chain, if it is the game's window's and
    // D3D11's. A fault turns the overlay off for the session; the frame is presented regardless.
    auto draw(IDXGISwapChain& swap_chain) -> void;

    // The lifecycle thread, once the present hook is removed: gives the game window its procedure
    // back (window_input::unsubclass()). A failure means the module must stay loaded.
    auto unsubclass(std::chrono::milliseconds patience) -> result<void>;

private:
    struct game_frame {
        IDXGISwapChain* swap_chain = nullptr;
        ID3D11Device* device = nullptr;
        HWND window = nullptr;
    };

    auto draw_contained(const game_frame& frame) -> void;
    auto collect_build() -> void;
    auto start_over(ID3D11Device& device) -> void;
    auto start_build() -> void;
    auto render(const game_frame& frame) -> void;
    // A frame of every drawing feature, into the draw list, with their labels set in text.
    auto draw_features(draw::vec2 viewport) -> void;
    // A frame of the menu, when it is open, into the draw list.
    auto draw_menu(HWND window, draw::vec2 viewport) -> result<void>;
    // Tells the window's procedure the menu takes nothing this frame, so the game gets its input
    // while the menu isn't drawn.
    auto release_input() -> void;
    // The keys since the last frame into the registry's binds (only releases while the menu is
    // open) and into the menu.
    auto feed_keys() -> void;

    kit::worker_set* m_workers;
    kit::registry* m_features;
    kit::config_store* m_configs;
    world_domain* m_world;
    const kit::clock* m_clock;
    window_input m_input;
    // The feed's serial the last snapshot took everything up to.
    u64 m_consumed = 0;
    // The key tally the last frame took.
    key_tally m_keys_taken;
    bool m_has_taken_input = false;
    overlay_state m_state;
    std::optional<text::text_system> m_text;
    // The face features' labels are set in; set with the text system.
    std::optional<text::face_id> m_face;
    // Held here while ready or between builds; a build in flight has it instead.
    std::optional<d3d11::renderer> m_renderer;
    std::unique_ptr<renderer_build> m_build;
    draw::draw_list m_list;
    // The dev names in a dev build; empty in a release until the server delivers the session's
    // catalog, so every label is its placeholder. The menu borrows it.
    menu::table_catalog m_menu_text;
    // The menu's text fields copy and paste through it.
    system_clipboard m_clipboard;
    // Borrows the text system and the menu text, so it is dropped first.
    std::optional<menu::settings_menu> m_menu;
    // Dev builds only.
    std::optional<dev_demo> m_demo;
    std::optional<dev_stats> m_stats;
};

}
