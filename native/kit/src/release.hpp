#pragma once

#include <lucent/kit/boot_info.hpp>

namespace lucent::kit::detail {

// Ends the lifecycle thread by freeing the module the way its image was loaded. The last call on
// that thread, and only once nothing else can run the module's code.
[[noreturn]] auto release_module(image_kind kind, u64 trampolines) -> void;

}
