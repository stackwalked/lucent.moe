#include "key/passphrase.hpp"

#include <algorithm>
#include <array>
#include <cstdio>
#include <expected>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>

namespace lucent::codekey {
namespace {

// A passphrase longer than this is refused rather than cut.
constexpr usize max_characters = 1024;

auto wipe_text(std::wstring& text) -> void {
    crypto::wipe(std::as_writable_bytes(std::span{text}));
    text.clear();
}

auto read_console_line(HANDLE input) -> result<std::wstring> {
    DWORD mode = 0;
    if (GetConsoleMode(input, &mode) == 0) {
        return std::unexpected(last_system_error());
    }
    SetConsoleMode(input, (mode & ~DWORD{ENABLE_ECHO_INPUT}) | ENABLE_LINE_INPUT);
    std::wstring line(max_characters + 2, L'\0');
    DWORD read = 0;
    const BOOL is_read =
        ReadConsoleW(input, line.data(), narrow<DWORD>(line.size()), &read, nullptr);
    SetConsoleMode(input, mode);
    std::println(stderr);
    if (is_read == 0) {
        wipe_text(line);
        return std::unexpected(last_system_error());
    }
    line.resize(read);
    return line;
}

// Bytes up to the newline, decoded as UTF-8 by the caller's conversion below.
auto read_piped_line(HANDLE input) -> result<std::wstring> {
    std::vector<char> bytes;
    for (;;) {
        std::array<char, 1> one{};
        DWORD read = 0;
        if (ReadFile(input, one.data(), 1, &read, nullptr) == 0 || read == 0) {
            break;
        }
        if (one.front() == '\n' || bytes.size() > max_characters * 4) {
            break;
        }
        bytes.push_back(one.front());
    }
    std::wstring line(bytes.size(), L'\0');
    const i32 size = MultiByteToWideChar(
        CP_UTF8,
        MB_ERR_INVALID_CHARS,
        bytes.data(),
        narrow<i32>(bytes.size()),
        line.data(),
        narrow<i32>(line.size())
    );
    crypto::wipe(std::as_writable_bytes(std::span{bytes}));
    if (size == 0 && !bytes.empty()) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    line.resize(narrow<usize>(size));
    return line;
}

// The line without its CR or LF: what the person typed.
auto typed_size(std::wstring_view line) -> usize {
    usize size = line.size();
    while (size > 0 && (line.at(size - 1) == L'\n' || line.at(size - 1) == L'\r')) {
        --size;
    }
    return size;
}

}

auto read_passphrase(std::string_view prompt) -> result<crypto::secret_bytes> {
    std::print(stderr, "{}: ", prompt);
    void* const input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    const bool is_console = GetConsoleMode(input, &mode) != 0;
    std::wstring line =
        is_console ? LUCENT_TRY(read_console_line(input)) : LUCENT_TRY(read_piped_line(input));
    const usize typed = typed_size(line);
    std::fill(line.begin() + narrow<isize>(typed), line.end(), L'\0');
    line.resize(typed);
    if (line.size() > max_characters) {
        wipe_text(line);
        return std::unexpected(error{.code = error_code::malformed});
    }
    const i32 size = WideCharToMultiByte(
        CP_UTF8, 0, line.data(), narrow<i32>(line.size()), nullptr, 0, nullptr, nullptr
    );
    crypto::secret_bytes out = crypto::secret_bytes::zeroed(narrow<usize>(size));
    WideCharToMultiByte(
        CP_UTF8,
        0,
        line.data(),
        narrow<i32>(line.size()),
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and char share one object representation; Win32 takes LPSTR.
        reinterpret_cast<char*>(out.as_writable_bytes().data()),
        size,
        nullptr,
        nullptr
    );
    wipe_text(line);
    return out;
}

}
