#include <optional>
#include <utility>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/manualmap/map.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_memory.hpp>

namespace lucent::manualmap {
namespace {

TEST_CASE("attach refuses an image without an entry point instead of calling address zero") {
    const result<os::process> self = os::process::open(GetCurrentProcessId());
    REQUIRE(self.has_value());
    result<os::remote_region> region =
        os::remote_region::allocate(*self, 0x1000, os::page_access::read_write);
    REQUIRE(region.has_value());
    const mapped image{
        .image = std::move(*region),
        .trampolines = std::nullopt,
        .entry_point = 0,
        .exception_table = 0,
        .exception_count = 0,
    };

    const result<void> attached = attach(*self, image, 0);

    REQUIRE_FALSE(attached.has_value());
    CHECK(attached.error().code == error_code::unsupported);
}

}
}
