#include <lucent/integrity/boot_state.hpp>

#include <catch2/catch_test_macros.hpp>

#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {
namespace {

// Which bits are raised differs per machine; that each one can be read doesn't.
TEST_CASE("an unprivileged process can read every boot state bit") {
    const boot_state state = system_boot_state();

    CHECK(state.kernel_debugging != observation::unavailable);
    CHECK(state.test_signing != observation::unavailable);
    CHECK(state.enforcement_off != observation::unavailable);
}

}
}
