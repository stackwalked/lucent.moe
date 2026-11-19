#pragma once

#include <lucent/kit/wiring.hpp>

namespace lucent::cs2::features {

// Every feature the cs2 module ships, added in the order they run. A product strips a feature by
// leaving it out here.
auto wire(kit::wiring& features) -> void;

}
