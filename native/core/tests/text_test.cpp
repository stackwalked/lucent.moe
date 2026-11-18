#include <lucent/core/text.hpp>

#include <string>

#include <catch2/catch_test_macros.hpp>

namespace lucent {

TEST_CASE("text survives a round trip through UTF-16, beyond ASCII") {
    const std::string text = "C:\\Users\\yūki\\cs2 ✓ 😀";
    CHECK(to_utf8(to_wide(text)) == text);
}

TEST_CASE("a lone surrogate becomes the replacement character") {
    const std::wstring broken{L'a', static_cast<wchar_t>(0xd800), L'b'};
    CHECK(
        to_utf8(broken)
        == "a\xef\xbf\xbd"
           "b"
    );
}

}
