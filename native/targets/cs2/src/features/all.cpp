#include "all.hpp"

#include <lucent/kit/dev_build.hpp>
#include <lucent/kit/wiring.hpp>

#include "dev_sample.hpp"

namespace lucent::cs2::features {

// No real feature yet: the first comes with the world domain.
auto wire(kit::wiring& features) -> void {
    if constexpr (kit::is_dev_build) {
        features.add<dev_sample>();
    }
}

}
