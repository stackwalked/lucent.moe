#pragma once

#include <string>
#include <string_view>

namespace lucent {

// Text is UTF-8 everywhere except at the Win32 boundary, where these convert it on the spot.
// Ill-formed input becomes U+FFFD rather than failing.
auto to_utf8(std::wstring_view text) -> std::string;
auto to_wide(std::string_view text) -> std::wstring;

}
