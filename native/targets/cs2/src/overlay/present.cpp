#include "present.hpp"

#include <algorithm>
#include <array>
#include <tuple>

#include <Windows.h>

#include <d3d11.h>
#include <dxgi.h>

#include <d3d11_1.h>
#include <dxgiformat.h>
#include <wrl/client.h>

#include <lucent/core/contain.hpp>
#include <lucent/kit/hook.hpp>

#include "dxgi_present.hpp"

namespace lucent::cs2::overlay {
namespace {

struct typed_view {
    DXGI_FORMAT stored;
    DXGI_FORMAT view;
};

// A typeless back buffer needs a typed view; these are the typeless formats a swap chain may use.
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

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wlanguage-extension-token" // IID_PPV_ARGS spells __uuidof

// The walking skeleton's proof of life: a filled rectangle near the top-left corner. A swap chain
// that isn't D3D11 (Vulkan, D3D12) is left alone.
auto draw_marker(IDXGISwapChain& swap_chain) -> void {
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    if (FAILED(swap_chain.GetDevice(IID_PPV_ARGS(&device)))) {
        return;
    }
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    device->GetImmediateContext(&context);
    Microsoft::WRL::ComPtr<ID3D11DeviceContext1> context1;
    if (FAILED(context.As(&context1))) {
        return;
    }
    Microsoft::WRL::ComPtr<ID3D11Texture2D> back_buffer;
    if (FAILED(swap_chain.GetBuffer(0, IID_PPV_ARGS(&back_buffer)))) {
        return;
    }
    D3D11_TEXTURE2D_DESC stored{};
    back_buffer->GetDesc(&stored);
    D3D11_RENDER_TARGET_VIEW_DESC view{};
    view.Format = view_format_of(stored.Format);
    view.ViewDimension = D3D11_RTV_DIMENSION_TEXTURE2D;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> target;
    if (FAILED(device->CreateRenderTargetView(back_buffer.Get(), &view, &target))) {
        return;
    }
    constexpr std::array<f32, 4> magenta{1.0F, 0.0F, 0.6F, 1.0F};
    const D3D11_RECT corner{.left = 32, .top = 32, .right = 232, .bottom = 132};
    context1->ClearView(target.Get(), magenta.data(), &corner, 1);
}

#pragma clang diagnostic pop

using present_fn = HRESULT (*)(IDXGISwapChain*, UINT, UINT);

auto on_present(present_fn original, IDXGISwapChain* swap_chain, UINT interval, UINT flags)
    -> HRESULT {
    // The frame is presented whatever happens to the drawing.
    std::ignore = contain([&] { draw_marker(*swap_chain); });
    return original(swap_chain, interval, flags);
}

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): a hook slot is a constinit global by design; the hook_set owns it while installed.
constinit kit::hook_slot<HRESULT(IDXGISwapChain*, UINT, UINT)> present{&on_present};

}

auto present_hook() -> result<kit::hook_request> {
    const uptr target = LUCENT_TRY(dxgi_present_address());
    return kit::hook_on<present>(target);
}

}
