#include "present.hpp"

#include <Windows.h>

#include <dxgi.h>

#include <lucent/kit/hook.hpp>

#include "dxgi_present.hpp"
#include "overlay.hpp"

namespace lucent::cs2::overlay {
namespace {

// The attachment's overlay. Written by present_hook() before the hook is installed, which
// publishes it to the detour (install stores the original with release, the detour loads it with
// acquire), and read only by the detour while the hook is installed.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the plain function the game calls can reach it no other way; the attachment owns what it points at.
constinit overlay* drawn_overlay = nullptr;

using present_fn = HRESULT (*)(IDXGISwapChain*, UINT, UINT);

auto on_present(present_fn original, IDXGISwapChain* swap_chain, UINT interval, UINT flags)
    -> HRESULT {
    drawn_overlay->draw(*swap_chain);
    return original(swap_chain, interval, flags);
}

// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): a hook slot is a constinit global by design; the hook_set owns it while installed.
constinit kit::hook_slot<HRESULT(IDXGISwapChain*, UINT, UINT)> present{&on_present};

}

auto present_hook(overlay& drawn) -> result<kit::hook_request> {
    const uptr target = LUCENT_TRY(dxgi_present_address());
    drawn_overlay = &drawn;
    return kit::hook_on<present>(target);
}

}
