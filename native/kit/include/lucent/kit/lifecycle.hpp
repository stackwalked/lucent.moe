#pragma once

#include <lucent/kit/boot_info.hpp>

namespace lucent::kit {

// Starts the module's lifecycle thread and returns at once. The thread reports each stage to the
// host, runs until the host asks it to unload or goes away, then frees the module. Call once, on
// the thread the host started the module with.
auto start(const boot_info& info) -> result<void>;

}
