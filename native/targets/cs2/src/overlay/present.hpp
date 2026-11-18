#pragma once

#include <lucent/kit/hook.hpp>

namespace lucent::cs2::overlay {

// The hook that draws over each frame the game presents through D3D11.
auto present_hook() -> result<kit::hook_request>;

}
