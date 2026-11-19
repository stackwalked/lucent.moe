#include <lucent/kit/core_capabilities.hpp>

#include <array>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// A core capability missed here would start a product that can't do its core job; an optional one
// caught here would refuse a start that should have degraded; a core one waiting for a late module
// judged failed would refuse a start the module's later load would have made good.

namespace lucent::kit {
namespace {

constexpr u8 boot_module = 1;
constexpr u8 late_module = 2;

constexpr auto record(u64 key, u8 module, fact_status status) -> fact_record {
    return fact_record{
        .key = key,
        .kind = fact_kind::value,
        .module = module,
        .width = 4,
        .alignment = 4,
        .status = status,
        .reserved = 0,
        .bound = 0,
        .value = 0,
    };
}

constexpr std::array records{
    record(0xa1, boot_module, fact_status::resolved),
    record(0xa2, boot_module, fact_status::resolved),
    record(0xb1, boot_module, fact_status::rejected),
    record(0xc1, boot_module, fact_status::unresolved),
    record(0xe1, late_module, fact_status::unresolved),
    record(0xe2, late_module, fact_status::resolved),
};

constexpr std::array only_boot{boot_module};
constexpr std::array both{boot_module, late_module};

auto declared(u64 key, capability_level level, std::vector<u64> members) -> declared_capability {
    return declared_capability{.key = key, .level = level, .members = std::move(members)};
}

}

TEST_CASE("a core capability whose facts all resolved lets the start go on") {
    const std::array capabilities{declared(0x1, capability_level::core, {0xa1, 0xa2})};

    CHECK(judge_core(capabilities, records, only_boot) == core_judgment{});
}

TEST_CASE(
    "a core capability with a rejected, unresolved or missing fact of a loaded module fails"
) {
    const std::array capabilities{
        declared(0x1, capability_level::core, {0xa1, 0xb1}),
        declared(0x2, capability_level::core, {0xc1}),
        declared(0x3, capability_level::core, {0xa1, 0xd1}),
        declared(0x4, capability_level::core, {0xa2}),
    };

    const core_judgment judged = judge_core(capabilities, records, only_boot);

    CHECK(judged.failed == std::vector<u64>{0x1, 0x2, 0x3});
    CHECK(judged.waiting.empty());
}

TEST_CASE("a core capability waiting only for a module the game hasn't loaded waits") {
    const std::array capabilities{declared(0x1, capability_level::core, {0xa1, 0xe1})};

    const core_judgment judged = judge_core(capabilities, records, only_boot);

    CHECK(judged.failed.empty());
    CHECK(judged.waiting == std::vector<u64>{0x1});
}

TEST_CASE("a core capability fails once its late module loaded without resolving its facts") {
    const std::array capabilities{declared(0x1, capability_level::core, {0xa1, 0xe1})};

    const core_judgment judged = judge_core(capabilities, records, both);

    CHECK(judged.failed == std::vector<u64>{0x1});
    CHECK(judged.waiting.empty());
}

TEST_CASE("a core capability failing in a loaded module fails though another module is late") {
    const std::array capabilities{declared(0x1, capability_level::core, {0xb1, 0xe1})};

    CHECK(judge_core(capabilities, records, only_boot).failed == std::vector<u64>{0x1});
}

TEST_CASE("an unavailable optional capability is never judged") {
    const std::array capabilities{declared(0x1, capability_level::optional, {0xb1, 0xe1})};

    CHECK(judge_core(capabilities, records, only_boot) == core_judgment{});
}

}
