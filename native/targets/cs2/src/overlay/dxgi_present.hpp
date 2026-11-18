#pragma once

namespace lucent::cs2::overlay {

// The address of DXGI's IDXGISwapChain::Present in this process, read from a throwaway swap
// chain's vtable. Public API, not a game fact: every D3D11 swap chain in the process shares it.
auto dxgi_present_address() -> result<uptr>;

}
