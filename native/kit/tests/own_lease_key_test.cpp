#include "../src/own_lease_key.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include <catch2/catch_test_macros.hpp>

#include <lucent/crypto/crypto.hpp>

namespace lucent::kit::detail {
namespace {

// Encoded the other way from the module's decoder, so a mistake in either shows.
auto to_base64url(const crypto::public_key& key) -> std::string {
    constexpr std::string_view alphabet =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string text;
    u32 bits = 0;
    u32 held = 0;
    for (const std::byte byte : key) {
        bits = (bits << 8U) | std::to_integer<u32>(byte);
        held += 8;
        while (held >= 6) {
            held -= 6;
            text.push_back(alphabet.at((bits >> held) & 0x3fU));
        }
    }
    if (held > 0) {
        text.push_back(alphabet.at((bits << (6 - held)) & 0x3fU));
    }
    return text;
}

}

// The build defines the key this test expects as the tree's LUCENT_LEASE_PUBLIC_KEY in Release,
// and as empty in any other configuration.
TEST_CASE("a release module holds the lease key its tree was configured with, and dev has none") {
    // NOLINTNEXTLINE(readability-redundant-string-init): the macro is the key in Release, empty only elsewhere.
    const std::string_view expected = LUCENT_KIT_TEST_LEASE_PUBLIC_KEY;
    const std::optional<crypto::public_key> own = own_lease_key();

    if (expected.empty()) {
        CHECK(own == std::nullopt);
    } else {
        REQUIRE(own.has_value());
        CHECK(to_base64url(*own) == expected);
    }
}

}
