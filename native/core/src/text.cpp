#include <lucent/core/text.hpp>

#include <string>
#include <string_view>

#include <Windows.h>

#include <lucent/core/narrow.hpp>

namespace lucent {

auto to_utf8(std::wstring_view text) -> std::string {
    if (text.empty()) {
        return {};
    }
    const auto length = narrow<int>(std::ssize(text));
    const int size =
        WideCharToMultiByte(CP_UTF8, 0, text.data(), length, nullptr, 0, nullptr, nullptr);
    LUCENT_INVARIANT(size > 0);
    std::string converted(narrow<usize>(size), '\0');
    const int written = WideCharToMultiByte(
        CP_UTF8, 0, text.data(), length, converted.data(), size, nullptr, nullptr
    );
    LUCENT_INVARIANT(written == size);
    return converted;
}

auto to_wide(std::string_view text) -> std::wstring {
    if (text.empty()) {
        return {};
    }
    const auto length = narrow<int>(std::ssize(text));
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.data(), length, nullptr, 0);
    LUCENT_INVARIANT(size > 0);
    std::wstring converted(narrow<usize>(size), L'\0');
    const int written =
        MultiByteToWideChar(CP_UTF8, 0, text.data(), length, converted.data(), size);
    LUCENT_INVARIANT(written == size);
    return converted;
}

}
