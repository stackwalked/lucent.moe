#pragma once

#include <lucent/kit/session.hpp>

namespace lucent::loader_dev {

// Prints what the module sends until it closes its end; blocks the calling thread until then.
auto relay(kit::session& channel) -> void;

}
