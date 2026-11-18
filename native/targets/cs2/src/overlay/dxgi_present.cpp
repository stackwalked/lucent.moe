#include "dxgi_present.hpp"

#include <bit>
#include <expected>

#include <Windows.h>

#include <d3d11.h>
#include <dxgi.h>

#include <wrl/client.h>

namespace lucent::cs2::overlay {
namespace {

// build: Windows SDK 10.0.26100.0, dxgi.h
// found: IDXGISwapChain's declaration order: IUnknown's 3 methods, IDXGIObject's 4,
//        IDXGIDeviceSubObject's GetDevice, then Present
// breaks: the hook lands on another swap-chain method; the game misbehaves on its next frame
constexpr usize present_slot = 8;

auto failed_with(HRESULT code) -> error {
    // An HRESULT, not a GetLastError() value; both are Windows' codes for what went wrong.
    return error{.code = error_code::system, .system_code = std::bit_cast<u32>(code)};
}

// A window that is never shown, only so the throwaway swap chain has an output.
class hidden_window final {
public:
    hidden_window()
        : m_window{
              CreateWindowExW(
                  0, L"STATIC", L"", WS_OVERLAPPED, 0, 0, 64, 64, nullptr, nullptr, nullptr, nullptr
              ),
          } {}

    hidden_window(const hidden_window&) = delete ("owns the window");
    auto operator=(const hidden_window&) -> hidden_window& = delete ("owns the window");
    hidden_window(hidden_window&&) = delete ("owns the window");
    auto operator=(hidden_window&&) -> hidden_window& = delete ("owns the window");

    ~hidden_window() {
        if (m_window != nullptr) {
            DestroyWindow(m_window);
        }
    }

    auto native() const -> HWND {
        return m_window;
    }

private:
    HWND m_window;
};

}

auto dxgi_present_address() -> result<uptr> {
    const hidden_window window;
    if (window.native() == nullptr) {
        return std::unexpected(last_system_error());
    }
    DXGI_SWAP_CHAIN_DESC description{};
    description.BufferCount = 1;
    description.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.OutputWindow = window.native();
    description.SampleDesc.Count = 1;
    description.Windowed = TRUE;
    description.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    Microsoft::WRL::ComPtr<IDXGISwapChain> swap_chain;
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    const HRESULT created = D3D11CreateDeviceAndSwapChain(
        nullptr,
        D3D_DRIVER_TYPE_HARDWARE,
        nullptr,
        0,
        nullptr,
        0,
        D3D11_SDK_VERSION,
        &description,
        &swap_chain,
        &device,
        nullptr,
        nullptr
    );
    if (FAILED(created)) {
        return std::unexpected(failed_with(created));
    }
    // A COM object starts with its vtable pointer; DXGI's own object, which we just created.
    const void* const object = swap_chain.Get();
    const uptr* const vtable = *static_cast<const uptr* const*>(object);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage" // a COM vtable: sized by its interface
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-pointer-arithmetic): a COM vtable has no span; its interface fixes the length.
    return vtable[present_slot];
#pragma clang diagnostic pop
}

}
