#pragma once

#include <memory>
#include <optional>

#include <d3d11.h>
#include <dxgi.h>

#include <lucent/cs2-overlay/overlay_state.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/text/text_system.hpp>

#include "dev_demo.hpp"
#include "renderer_build.hpp"

namespace lucent::cs2::overlay {

// What the module draws over the game's frames, and everything it draws them with.
//
// Threads: made and dropped on the lifecycle thread while the present hook is not installed; in
// between, draw() runs on whatever thread presents, and past the choice of swap chain only on the
// one presenting the game's window. The worker set outlives the overlay.
class overlay final {
public:
    explicit overlay(kit::worker_set& workers);
    overlay(const overlay&) = delete ("the present hook holds its address");
    auto operator=(const overlay&) -> overlay& = delete ("the present hook holds its address");
    overlay(overlay&&) = delete ("the present hook holds its address");
    auto operator=(overlay&&) -> overlay& = delete ("the present hook holds its address");
    ~overlay();

    // Draws over the frame about to be presented on swap_chain, if it is the game's window's and
    // D3D11's. A fault turns the overlay off for the session; the frame is presented regardless.
    auto draw(IDXGISwapChain& swap_chain) -> void;

private:
    auto draw_contained(IDXGISwapChain& swap_chain, ID3D11Device& device) -> void;
    auto collect_build() -> void;
    auto start_over(ID3D11Device& device) -> void;
    auto start_build() -> void;
    auto render(IDXGISwapChain& swap_chain, ID3D11Device& device) -> void;

    kit::worker_set* m_workers;
    overlay_state m_state;
    std::optional<text::text_system> m_text;
    // Held here while ready or between builds; a build in flight has it instead.
    std::optional<d3d11::renderer> m_renderer;
    std::unique_ptr<renderer_build> m_build;
    draw::draw_list m_list;
    // Dev builds only.
    std::optional<dev_demo> m_demo;
};

}
