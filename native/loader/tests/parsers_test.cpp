#include <array>
#include <cstddef>
#include <optional>
#include <string_view>
#include <variant>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include "account/callback.hpp"
#include "account/sign_in.hpp"
#include "text/base64url.hpp"
#include "text/json.hpp"

// What the loader reads from outside: the browser's callback, the OAuth replies, base64url.

namespace lucent::loader {
namespace {

TEST_CASE("base64url round-trips without padding and refuses a second spelling") {
    const std::array bytes{std::byte{0xfb}, std::byte{0xff}, std::byte{0x00}, std::byte{0x10}};
    REQUIRE(to_base64url(bytes) == "-_8AEA");
    REQUIRE(from_base64url("-_8AEA") == std::vector<std::byte>{bytes.begin(), bytes.end()});
    REQUIRE_FALSE(from_base64url("-_8AEA=="));
    // The last character's leftover bits are not zero, so it isn't the canonical spelling.
    REQUIRE_FALSE(from_base64url("-_8AEB"));
    REQUIRE_FALSE(from_base64url("A"));
}

TEST_CASE("hex is lowercase two digits a byte, as /v1 paths spell ids") {
    const std::array bytes{std::byte{0xab}, std::byte{0x01}};
    REQUIRE(to_hex(bytes) == "ab01");
    REQUIRE(from_hex("ab01") == std::vector<std::byte>{bytes.begin(), bytes.end()});
    REQUIRE_FALSE(from_hex("AB01"));
    REQUIRE_FALSE(from_hex("ab0"));
}

TEST_CASE("a token reply reads its strings and its lifetime") {
    const result<json_object> parsed = parse_flat_object(
        R"( {"access_token":"lat_aé😀","token_type":"DPoP","expires_in":300,)"
        R"("refresh_token":"lrt_b","scope":null} )"
    );
    REQUIRE(parsed);
    REQUIRE(string_member(*parsed, "access_token") == "lat_a\xc3\xa9\xf0\x9f\x98\x80");
    REQUIRE(integer_member(*parsed, "expires_in") == 300);
    REQUIRE(string_member(*parsed, "token_type") == "DPoP");
    REQUIRE_FALSE(string_member(*parsed, "scope"));
    REQUIRE_FALSE(string_member(*parsed, "expires_in"));
}

TEST_CASE("JSON the loader has no use for is refused rather than half read") {
    for (const std::string_view text : {
             R"({"a":{"b":1}})",
             R"({"a":[1]})",
             R"({"a":1.5})",
             R"({"a":01})",
             R"({"a":1,"a":2})",
             R"({"a":"\ud83d"})",
             R"({"a":1} x)",
             R"({"a":1,})",
             "{\"a\":\"\x01\"}",
         }) {
        INFO(text);
        REQUIRE(!parse_flat_object(text).has_value());
    }
}

TEST_CASE("a JSON string escapes quotes, backslashes and control characters") {
    REQUIRE(to_json_string("a\"b\\c\n") == R"("a\"b\\c\u000a")");
}

TEST_CASE("the browser's callback carries the code and state") {
    const result<callback_result> parsed = parse_callback_request(
        "GET /callback?code=lac_x%2By&state=s+1 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    );
    REQUIRE(parsed);
    REQUIRE(*parsed == callback_result{authorized{.code = "lac_x+y", .state = "s 1"}});
}

TEST_CASE("a denied approval comes back as access_denied with the state") {
    const result<callback_result> parsed =
        parse_callback_request("GET /callback?error=access_denied&state=s HTTP/1.1\r\n\r\n");
    REQUIRE(parsed);
    REQUIRE(*parsed == callback_result{denied{.state = "s"}});
}

TEST_CASE("anything but one callback with a state is not a callback") {
    REQUIRE(
        parse_callback_request("GET /favicon.ico HTTP/1.1\r\n\r\n").error().code
        == error_code::not_found
    );
    REQUIRE(
        parse_callback_request("POST /callback?code=a&state=s HTTP/1.1\r\n\r\n").error().code
        == error_code::not_found
    );
    REQUIRE_FALSE(parse_callback_request("GET /callback?code=a HTTP/1.1\r\n\r\n"));
    REQUIRE_FALSE(parse_callback_request("GET /callback?code=a&error=x&state=s HTTP/1.1\r\n\r\n"));
    REQUIRE_FALSE(parse_callback_request("GET /callback?code=a&code=b&state=s HTTP/1.1\r\n\r\n"));
    REQUIRE_FALSE(parse_callback_request("GET /callback?code=%zz&state=s HTTP/1.1\r\n\r\n"));
}

TEST_CASE("a form percent-encodes everything outside the unreserved set") {
    const std::array fields{
        form_field{.name = "redirect_uri", .value = "http://127.0.0.1:5000/callback"},
        form_field{.name = "state", .value = "a b~"},
    };
    REQUIRE(
        form_encoded(fields) == "redirect_uri=http%3A%2F%2F127.0.0.1%3A5000%2Fcallback&state=a%20b~"
    );
}

TEST_CASE("a pushed request's uri names its lauth_ id, and nothing else passes") {
    REQUIRE(
        request_id_of("urn:ietf:params:oauth:request_uri:lauth_AAAAAAAAAAAAAAAAAAAAAA")
        == "lauth_AAAAAAAAAAAAAAAAAAAAAA"
    );
    REQUIRE_FALSE(request_id_of("urn:ietf:params:oauth:request_uri:lauth_AAAA"));
    REQUIRE_FALSE(request_id_of("urn:ietf:params:oauth:request_uri:../../x"));
    REQUIRE_FALSE(request_id_of("lauth_AAAAAAAAAAAAAAAAAAAAAA"));
}

}
}
