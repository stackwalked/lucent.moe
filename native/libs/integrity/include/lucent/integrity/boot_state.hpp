#pragma once

#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {

// How the running Windows was booted, as far as it weakens what code it trusts.
struct boot_state {
    observation kernel_debugging = observation::unavailable;
    observation test_signing = observation::unavailable;
    // Kernel code integrity (driver signature enforcement) is off.
    observation enforcement_off = observation::unavailable;

    auto operator==(const boot_state&) const -> bool = default;
};

auto system_boot_state() -> boot_state;

}
