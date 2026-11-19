#pragma once

#include <lucent/kit/hook.hpp>

#include "overlay.hpp"

namespace lucent::cs2::overlay {

// The hook that draws `drawn` over each frame the game presents. Call on the lifecycle thread
// before installing the hook; `drawn` must outlive it, until the hook_set holding it is removed.
auto present_hook(overlay& drawn) -> result<kit::hook_request>;

}
