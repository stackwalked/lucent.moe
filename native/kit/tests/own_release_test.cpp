#include <lucent/kit/own_release.hpp>

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/wire/ids.hpp>

namespace lucent::kit {
namespace {

auto to_hex(const wire::release_id& id) -> std::string {
    constexpr std::string_view digits = "0123456789abcdef";
    std::string hex;
    for (const std::byte byte : id.bytes) {
        const auto value = std::to_integer<u8>(byte);
        hex.push_back(digits.at(value >> 4U));
        hex.push_back(digits.at(value & 0x0fU));
    }
    return hex;
}

}

// The build defines the id this test expects as the tree's LUCENT_RELEASE_ID in Release, and as
// empty in any other configuration.
TEST_CASE("a module knows the release id its build tree was configured with, and dev has none") {
    // NOLINTNEXTLINE(readability-redundant-string-init): the macro is the id in Release, empty only elsewhere.
    const std::string_view expected = LUCENT_KIT_TEST_RELEASE_ID;
    const std::optional<wire::release_id> own = own_release();

    if (expected.empty()) {
        CHECK(own == std::nullopt);
    } else {
        REQUIRE(own.has_value());
        CHECK(to_hex(*own) == expected);
    }
}

}
