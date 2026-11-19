#include "overlay.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
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
#include <lucent/cs2-domains/world_domain.hpp>
#include <lucent/cs2-overlay/input_feed.hpp>
#include <lucent/cs2-overlay/overlay_state.hpp>
#include <lucent/cs2-overlay/window_input.hpp>
#include <lucent/d3d11/renderer.hpp>
#include <lucent/draw/draw_list.hpp>
#include <lucent/draw/vec2.hpp>
#include <lucent/kit/canvas.hpp>
#include <lucent/kit/clock.hpp>
#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/published.hpp>
#include <lucent/kit/registry.hpp>
#include <lucent/kit/view_set.hpp>
#include <lucent/text/glyph_atlas.hpp>
#include <lucent/text/text_layout.hpp>
#include <lucent/text/text_system.hpp>
#include <lucent/ui/context.hpp>

#include "dev_demo.hpp"
#include "renderer_build.hpp"
#include "settings_menu.hpp"
#include "system_font.hpp"

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

struct game_window {
    ComPtr<ID3D11Device> device;
    HWND window = nullptr;
};

// The game's window and the D3D11 device behind its swap chain; no device for any other swap
// chain, which the overlay leaves alone (Vulkan and D3D12 ones included).
auto game_window_of(IDXGISwapChain& swap_chain) -> game_window {
    DXGI_SWAP_CHAIN_DESC description{};
    if (FAILED(swap_chain.GetDesc(&description)) || !is_game_window(description.OutputWindow)) {
        return {};
    }
    // A failed call leaves the pointer empty.
    game_window found{.device = nullptr, .window = description.OutputWindow};
    std::ignore = swap_chain.GetDevice(IID_PPV_ARGS(&found.device));
    return found;
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

// Empty when the window has none to give: the cursor is then left unscaled.
auto client_size_of(HWND window) -> draw::vec2 {
    RECT client{};
    if (GetClientRect(window, &client) == FALSE) {
        return {};
    }
    return {
        .x = static_cast<f32>(client.right - client.left),
        .y = static_cast<f32>(client.bottom - client.top),
    };
}

}

overlay::overlay(overlay_parts parts)
    : m_workers{parts.workers}
    , m_features{parts.features}
    , m_world{parts.world}
    , m_clock{parts.time} {
    LUCENT_INVARIANT(
        m_workers != nullptr && m_features != nullptr && m_world != nullptr && m_clock != nullptr
    );
}

overlay::~overlay() = default;

auto overlay::draw(IDXGISwapChain& swap_chain) -> void {
    game_window found;
    // A fault here may be on any presenting thread, so it changes no state: that frame is skipped.
    if (!contain([&] { found = game_window_of(swap_chain); }) || found.device == nullptr) {
        return;
    }
    const game_frame frame{
        .swap_chain = &swap_chain,
        .device = found.device.Get(),
        .window = found.window,
    };
    if (!contain([&] { draw_contained(frame); })) {
        m_state.turn_off();
        std::ignore = contain([this] { release_input(); });
    }
}

auto overlay::unsubclass(std::chrono::milliseconds patience) -> result<void> {
    return m_input.unsubclass(patience);
}

auto overlay::draw_contained(const game_frame& frame) -> void {
    m_input.subclass(std::bit_cast<window_id>(frame.window));
    // The game's frame stage will own the safe point and the world's update once a hook there
    // exists (it needs a method fact for the frame stage call, which no finder derives yet). Until
    // then the game window's frames are the registry's ticks and the world's frames: this one,
    // before the menu reads the snapshot, publishes what the menu asked for last frame, then reads
    // the players the features draw.
    m_features->safe_point();
    m_world->update();
    m_has_taken_input = false;
    collect_build();
    switch (m_state.frame(id_of(*frame.device))) {
    case frame_action::none:
        break;
    case frame_action::start_over:
        start_over(*frame.device);
        break;
    case frame_action::build:
        start_build();
        break;
    case frame_action::draw_with_atlas:
        LUCENT_INVARIANT(m_renderer.has_value() && m_text.has_value());
        m_renderer->upload_atlas(to_uploads(m_text->every_page()));
        render(frame);
        break;
    case frame_action::draw:
        render(frame);
        break;
    }
    if (!m_has_taken_input) {
        release_input();
    }
}

auto overlay::collect_build() -> void {
    if (m_build == nullptr) {
        return;
    }
    std::optional<d3d11::renderer> landed = m_build->take();
    if (!landed) {
        return;
    }
    m_renderer = std::move(landed);
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
        const result<text::face_id> face = add_message_font(*m_text);
        if (!face) {
            m_state.turn_off();
            return;
        }
        m_face = *face;
        m_menu.emplace(*m_text, *face, *m_features);
        if constexpr (kit::is_dev_build) {
            m_demo.emplace(*face);
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

auto overlay::render(const game_frame& frame) -> void {
    LUCENT_INVARIANT(m_renderer.has_value() && m_text.has_value() && m_menu.has_value());
    if constexpr (kit::is_dev_build) {
        LUCENT_INVARIANT(m_demo.has_value());
    }
    // Made for this frame and released before Present returns, so no back buffer outlives the
    // frame and a resize needs nothing of the overlay.
    const ComPtr<ID3D11Texture2D> back_buffer = back_buffer_of(*frame.swap_chain);
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
    if (FAILED(frame.device->CreateRenderTargetView(back_buffer.Get(), &view_description, &view))) {
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
    const draw::vec2 viewport{
        .x = static_cast<f32>(stored.Width),
        .y = static_cast<f32>(stored.Height),
    };
    // Under the menu, so the menu stays readable over a box.
    draw_features(viewport);
    if (!draw_menu(frame.window, viewport)) {
        m_state.turn_off();
        return;
    }
    LUCENT_INVARIANT(m_renderer.has_value() && m_text.has_value());
    m_renderer->upload_atlas(to_uploads(m_text->take_patches()));
    const result<void> rendered = m_renderer->render(m_list.frame(), target);
    // Unsupported is a target the renderer refuses as designed (HDR): nothing is drawn on it.
    if (!rendered && rendered.error().code != error_code::unsupported) {
        m_state.turn_off();
    }
}

auto overlay::draw_features(draw::vec2 viewport) -> void {
    LUCENT_INVARIANT(m_text.has_value() && m_face.has_value());
    kit::canvas onto{m_list, viewport};
    {
        // Held only while features draw: the published frame isn't kept past it.
        const kit::published<world_frame>::reading seen = m_world->read();
        kit::view_set parts;
        if (seen->players) {
            parts.put(*seen->players);
        }
        if (seen->camera) {
            parts.put(*seen->camera);
        }
        m_features->draw(parts, onto);
    }
    for (const kit::label& line : onto.labels()) {
        const result<const text::text_layout*> laid = m_text->layout({
            .utf8 = line.text,
            .style = {.face = *m_face, .size = line.size},
            .max_width = 0.0F,
            .wrap = text::text_wrap::none,
            .overflow = text::text_overflow::visible,
            .max_lines = std::nullopt,
            .pixels_per_unit = 1.0F,
        });
        // A name the text system can't lay out (not UTF-8, say) is left off; its box stays.
        if (!laid) {
            continue;
        }
        const draw::vec2 origin =
            line.anchor - draw::vec2{.x = (*laid)->size.x / 2.0F, .y = (*laid)->size.y};
        std::ignore = m_text->draw(m_list, **laid, origin, line.tint);
    }
}

auto overlay::draw_menu(HWND window, draw::vec2 viewport) -> result<void> {
    LUCENT_INVARIANT(m_menu.has_value());
    frame_snapshot taken;
    {
        const kit::published<input_feed>::reading feed = m_input.read();
        if (!feed->is_menu_open) {
            return {};
        }
        taken = snapshot_of(
            *feed,
            m_consumed,
            {.time = m_clock->now(), .client_size = client_size_of(window), .viewport = viewport}
        );
    }
    m_consumed = taken.consumed;
    const ui::frame_report wanted =
        LUCENT_TRY(m_menu->draw({.input = std::move(taken.input), .viewport = viewport}, m_list));
    m_input.report({
        .consumed = m_consumed,
        .wants_mouse = wanted.wants_mouse,
        .wants_keyboard = wanted.wants_keyboard,
    });
    m_has_taken_input = true;
    return {};
}

auto overlay::release_input() -> void {
    m_consumed = m_input.read()->serial;
    m_input.report({.consumed = m_consumed, .wants_mouse = false, .wants_keyboard = false});
}

}
