#include <lucent/kit/core_capabilities.hpp>

#include <array>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// A core capability missed here would start a product that can't do its core job; an optional one
// caught here would refuse a start that should have degraded.

namespace lucent::kit {
namespace {

constexpr auto record(u64 key, fact_status status) -> fact_record {
    return fact_record{
        .key = key,
        .kind = fact_kind::value,
        .module = 1,
        .width = 4,
        .alignment = 4,
        .status = status,
        .reserved = 0,
        .bound = 0,
        .value = 0,
    };
}

constexpr std::array records{
    record(0xa1, fact_status::resolved),
    record(0xa2, fact_status::resolved),
    record(0xb1, fact_status::rejected),
    record(0xc1, fact_status::unresolved),
};

auto declared(u64 key, capability_level level, std::vector<u64> members) -> declared_capability {
    return declared_capability{.key = key, .level = level, .members = std::move(members)};
}

}

TEST_CASE("a core capability whose facts all resolved lets the start go on") {
    const std::array capabilities{declared(0x1, capability_level::core, {0xa1, 0xa2})};

    CHECK(unavailable_core(capabilities, records).empty());
}

TEST_CASE("a core capability with a rejected, unresolved or missing fact refuses the start") {
    const std::array capabilities{
        declared(0x1, capability_level::core, {0xa1, 0xb1}),
        declared(0x2, capability_level::core, {0xc1}),
        declared(0x3, capability_level::core, {0xa1, 0xd1}),
        declared(0x4, capability_level::core, {0xa2}),
    };

    CHECK(unavailable_core(capabilities, records) == std::vector<u64>{0x1, 0x2, 0x3});
}

TEST_CASE("an unavailable optional capability leaves the start alone") {
    const std::array capabilities{declared(0x1, capability_level::optional, {0xb1, 0xc1})};

    CHECK(unavailable_core(capabilities, records).empty());
}

}
