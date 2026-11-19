#include <lucent/integrity/vm_vendor.hpp>

#include <array>

#include <intrin.h>

#include <catch2/catch_test_macros.hpp>

namespace lucent::integrity {
namespace {

// Which vendor differs per machine; that one is named exactly under a hypervisor doesn't.
TEST_CASE("a vendor is named exactly when CPUID says a hypervisor is present") {
    std::array<i32, 4> features{};
    __cpuidex(features.data(), 1, 0);
    const bool is_hypervisor_present = (static_cast<u32>(features[2]) & (1U << 31U)) != 0;

    CHECK((hypervisor_vendor() != vm_vendor::none) == is_hypervisor_present);
}

}
}
