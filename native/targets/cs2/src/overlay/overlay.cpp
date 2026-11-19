#include "overlay.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <memory>
#include <optional>
#include <span>
#include <tuple>
#include <utility>
#include <vector>

#include <Windows.h>

#include <d3d11.h>
#include <dxgi.h>

#include <dxgiformat.h>
#include <wrl/client.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/cs2-overlay/overlay_state.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/worker_set.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_system.hpp>

#include "dev_demo.hpp"
#include "renderer_build.hpp"

namespace lucent::cs2::overlay {
namespace {

using Microsoft::WRL::ComPtr;

struct typed_view {
    DXGI_FORMAT stored;
    DXGI_FORMAT view;
};

// A typeless back buffer needs a typed view; these are the typeless formats a swap chain may use.
// The renderer refuses the HDR ones (10-bit and float) for now, and the overlay stays off on them.
constexpr std::array typeless_views{
    typed_view{.stored = DXGI_FORMAT_R8G8B8A8_TYPELESS, .view = DXGI_FORMAT_R8G8B8A8_UNORM},
    typed_view{.stored = DXGI_FORMAT_B8G8R8A8_TYPELESS, .view = DXGI_FORMAT_B8G8R8A8_UNORM},
    typed_view{.stored = DXGI_FORMAT_R10G10B10A2_TYPELESS, .view = DXGI_FORMAT_R10G10B10A2_UNORM},
    typed_view{.stored = DXGI_FORMAT_R16G16B16A16_TYPELESS, .view = DXGI_FORMAT_R16G16B16A16_FLOAT},
};

auto view_format_of(DXGI_FORMAT stored) -> DXGI_FORMAT {
    const auto found = std::ranges::find(typeless_views, stored, &typed_view::stored);
    return found == typeless_views.end() ? stored : found->view;
}

// The game's main window: this process's, top-level, unowned and shown. That rules out child and
// tool windows, and the hidden window dxgi_present_address() makes its throwaway swap chain for.
auto is_game_window(HWND window) -> bool {
    if (window == nullptr) {
        return false;
    }
    DWORD process = 0;
    GetWindowThreadProcessId(window, &process);
    return process == GetCurrentProcessId()
           && GetAncestor(window, GA_ROOT) == window
           && GetWindow(window, GW_OWNER) == nullptr
           && IsWindowVisible(window) != FALSE;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // IID_PPV_ARGS spells __uuidof

// The D3D11 device behind the game window's swap chain; empty for any other swap chain, which
// the overlay leaves alone (Vulkan and D3D12 ones included).
auto game_window_device(IDXGISwapChain& swap_chain) -> ComPtr<ID3D11Device> {
    DXGI_SWAP_CHAIN_DESC description{};
    if (FAILED(swap_chain.GetDesc(&description)) || !is_game_window(description.OutputWindow)) {
        return {};
    }
    // A failed call leaves the pointer empty.
    ComPtr<ID3D11Device> device;
    std::ignore = swap_chain.GetDevice(IID_PPV_ARGS(&device));
    return device;
}

// Empty when the swap chain has none to give.
auto back_buffer_of(IDXGISwapChain& swap_chain) -> ComPtr<ID3D11Texture2D> {
    ComPtr<ID3D11Texture2D> back_buffer;
    std::ignore = swap_chain.GetBuffer(0, IID_PPV_ARGS(&back_buffer));
    return back_buffer;
}

#pragma clang diagnostic pop

auto id_of(const ID3D11Device& device) -> device_id {
    return device_id{std::bit_cast<uptr>(&device)};
}

auto outcome_of(d3d11::renderer_state built) -> build_outcome {
    switch (built) {
    case d3d11::renderer_state::ready:
        return build_outcome::ready;
    case d3d11::renderer_state::idle:
        return build_outcome::retry;
    case d3d11::renderer_state::failed:
        return build_outcome::given_up;
    case d3d11::renderer_state::building:
        LUCENT_UNREACHABLE();
    }
    LUCENT_UNREACHABLE();
}

// The text system's patches and the renderer's uploads match field for field until draw gives
// them one type.
auto to_uploads(std::span<const text::atlas_patch> patches) -> std::vector<d3d11::atlas_upload> {
    std::vector<d3d11::atlas_upload> uploads;
    uploads.reserve(patches.size());
    for (const text::atlas_patch& patch : patches) {
        uploads.push_back({
            .page = patch.page,
            .area = patch.area,
            .coverage = patch.coverage,
            .row_pitch = patch.row_pitch,
        });
    }
    return uploads;
}

}

overlay::overlay(kit::worker_set& workers)
    : m_workers{&workers} {}

overlay::~overlay() = default;

auto overlay::draw(IDXGISwapChain& swap_chain) -> void {
    ComPtr<ID3D11Device> device;
    // A fault here may be on any presenting thread, so it changes no state: that frame is skipped.
    if (!contain([&] { device = game_window_device(swap_chain); }) || device == nullptr) {
        return;
    }
    if (!contain([&] { draw_contained(swap_chain, *device.Get()); })) {
        m_state.turn_off();
    }
}

auto overlay::draw_contained(IDXGISwapChain& swap_chain, ID3D11Device& device) -> void {
    collect_build();
    switch (m_state.frame(id_of(device))) {
    case frame_action::none:
        return;
    case frame_action::start_over:
        start_over(device);
        return;
    case frame_action::build:
        start_build();
        return;
    case frame_action::draw_with_atlas:
        LUCENT_INVARIANT(m_renderer.has_value() && m_text.has_value());
        m_renderer->upload_atlas(to_uploads(m_text->every_page()));
        render(swap_chain, device);
        return;
    case frame_action::draw:
        render(swap_chain, device);
        return;
    }
}

auto overlay::collect_build() -> void {
    if (m_build == nullptr || !m_build->has_landed()) {
        return;
    }
    m_renderer = m_build->take();
    m_build.reset();
    m_state.landed(outcome_of(m_renderer->state()));
}

auto overlay::start_over(ID3D11Device& device) -> void {
    // The old device's renderer goes whole; the atlas re-uploads from the text system's CPU copy.
    m_renderer.reset();
    if (!m_text) {
        result<text::text_system> made = text::text_system::create({});
        if (!made) {
            m_state.turn_off();
            return;
        }
        m_text = std::move(*made);
        if constexpr (kit::is_dev_build) {
            result<dev_demo> demo = dev_demo::create(*m_text);
            if (!demo) {
                m_state.turn_off();
                return;
            }
            m_demo = *demo;
        }
    }
    ComPtr<ID3D11DeviceContext> context;
    device.GetImmediateContext(&context);
    result<d3d11::renderer> made = d3d11::renderer::from_device(&device, context.Get());
    if (!made) {
        m_state.landed(build_outcome::given_up);
        return;
    }
    m_renderer = std::move(*made);
    start_build();
}

auto overlay::start_build() -> void {
    LUCENT_INVARIANT(m_renderer.has_value());
    if (!m_renderer->is_multithreaded()) {
        // A single-threaded device is the presenting thread's alone, so the build is too.
        std::ignore = m_renderer->build();
        m_state.landed(outcome_of(m_renderer->state()));
        return;
    }
    d3d11::renderer built = std::move(*m_renderer);
    m_renderer.reset();
    result<std::unique_ptr<renderer_build>> started =
        renderer_build::start(*m_workers, std::move(built));
    if (!started) {
        m_state.turn_off();
        return;
    }
    m_build = std::move(*started);
}

auto overlay::render(IDXGISwapChain& swap_chain, ID3D11Device& device) -> void {
    LUCENT_INVARIANT(m_renderer.has_value() && m_text.has_value());
    if constexpr (kit::is_dev_build) {
        LUCENT_INVARIANT(m_demo.has_value());
    }
    // Made for this frame and released before Present returns, so no back buffer outlives the
    // frame and a resize needs nothing of the overlay.
    const ComPtr<ID3D11Texture2D> back_buffer = back_buffer_of(swap_chain);
    if (back_buffer == nullptr) {
        return;
    }
    D3D11_TEXTURE2D_DESC stored{};
    back_buffer->GetDesc(&stored);
    // A minimised window's buffer has no pixels to draw on.
    if (stored.Width == 0 || stored.Height == 0) {
        return;
    }
    D3D11_RENDER_TARGET_VIEW_DESC view_description{};
    view_description.Format = view_format_of(stored.Format);
    view_description.ViewDimension = stored.SampleDesc.Count > 1 ? D3D11_RTV_DIMENSION_TEXTURE2DMS
                                                                 : D3D11_RTV_DIMENSION_TEXTURE2D;
    ComPtr<ID3D11RenderTargetView> view;
    if (FAILED(device.CreateRenderTargetView(back_buffer.Get(), &view_description, &view))) {
        return;
    }
    const d3d11::render_target target{
        .view = view.Get(),
        .texture = back_buffer.Get(),
        .size = {.width = narrow<i32>(stored.Width), .height = narrow<i32>(stored.Height)},
        .format = static_cast<u32>(view_description.Format),
        .sample_count = stored.SampleDesc.Count,
    };
    m_text->begin_frame();
    m_list.reset({.size = target.size, .pixels_per_unit = 1.0F});
    if constexpr (kit::is_dev_build) {
        if (!m_demo->draw(*m_text, m_list)) {
            m_state.turn_off();
            return;
        }
    }
    m_renderer->upload_atlas(to_uploads(m_text->take_patches()));
    const result<void> rendered = m_renderer->render(m_list.frame(), target);
    // Unsupported is a target the renderer refuses as designed (HDR): nothing is drawn on it.
    if (!rendered && rendered.error().code != error_code::unsupported) {
        m_state.turn_off();
    }
}

}
