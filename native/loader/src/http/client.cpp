#include "http/client.hpp"

#include <array>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <winhttp.h>

#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>

namespace lucent::loader::http {
namespace {

// Connecting and sending are quick or not at all; a response may wait on the server's database.
constexpr i32 connect_timeout_ms = 10'000;
constexpr i32 receive_timeout_ms = 30'000;
constexpr usize read_size = usize{64} << 10U;

auto system_failure() -> error {
    return error{.code = error_code::system, .system_code = narrow<u32>(GetLastError())};
}

// A request handle, closed with this object.
class request_handle final {
public:
    explicit request_handle(HINTERNET handle)
        : m_handle{handle} {}

    request_handle(const request_handle&) = delete ("one owner per handle");
    auto operator=(const request_handle&) -> request_handle& = delete ("one owner per handle");
    request_handle(request_handle&&) = delete ("borrowed for one exchange");
    auto operator=(request_handle&&) -> request_handle& = delete ("borrowed for one exchange");

    ~request_handle() {
        WinHttpCloseHandle(m_handle);
    }

    auto native() const -> HINTERNET {
        return m_handle;
    }

private:
    HINTERNET m_handle;
};

// "Name: value\r\n" for each, as WinHttpAddRequestHeaders takes them.
auto header_block(std::span<const header> headers) -> std::wstring {
    std::string block;
    for (const header& each : headers) {
        block.append(each.name).append(": ").append(each.value).append("\r\n");
    }
    return to_wide(block);
}

auto query_number(HINTERNET handle, DWORD which) -> std::optional<DWORD> {
    DWORD value = 0;
    DWORD size = sizeof(value);
    if (WinHttpQueryHeaders(
            handle, which | WINHTTP_QUERY_FLAG_NUMBER, nullptr, &value, &size, nullptr
        )
        == FALSE) {
        return std::nullopt;
    }
    return value;
}

// build: FILETIME counts 100 ns intervals from 1601-01-01; the Unix epoch is 11644473600 s later
// found: the FILETIME documentation
// breaks: every DPoP proof after a clock correction is off by centuries and refused
constexpr i64 filetime_ticks_per_second = 10'000'000;
constexpr i64 unix_epoch_in_filetime_seconds = 11'644'473'600;

auto query_date(HINTERNET handle) -> std::optional<i64> {
    SYSTEMTIME date{};
    DWORD size = sizeof(date);
    if (WinHttpQueryHeaders(
            handle,
            WINHTTP_QUERY_DATE | WINHTTP_QUERY_FLAG_SYSTEMTIME,
            nullptr,
            &date,
            &size,
            nullptr
        )
        == FALSE) {
        return std::nullopt;
    }
    FILETIME file{};
    if (SystemTimeToFileTime(&date, &file) == FALSE) {
        return std::nullopt;
    }
    const u64 ticks = (u64{file.dwHighDateTime} << 32U) | file.dwLowDateTime;
    return (narrow<i64>(ticks) / filetime_ticks_per_second) - unix_epoch_in_filetime_seconds;
}

// Reads the body piece by piece into the sink, refusing past the bound.
auto read_body(HINTERNET handle, usize max_body, body_sink sink) -> result<void> {
    std::vector<std::byte> piece(read_size);
    usize total = 0;
    while (true) {
        DWORD got = 0;
        if (WinHttpReadData(handle, piece.data(), narrow<DWORD>(piece.size()), &got) == FALSE) {
            return std::unexpected(system_failure());
        }
        if (got == 0) {
            return {};
        }
        total += got;
        if (total > max_body) {
            return std::unexpected(error{.code = error_code::unsupported});
        }
        LUCENT_TRY(sink(std::span{piece}.first(got)));
    }
}

}

auto client::open(std::string_view origin) -> result<client> {
    const std::wstring wide = to_wide(origin);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    std::array<wchar_t, 256> host{};
    parts.lpszHostName = host.data();
    parts.dwHostNameLength = narrow<DWORD>(host.size());
    // Asked for, so a path or query in the origin is caught rather than ignored.
    parts.dwUrlPathLength = 1;
    parts.dwExtraInfoLength = 1;
    if (WinHttpCrackUrl(wide.c_str(), narrow<DWORD>(wide.size()), 0, &parts) == FALSE) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (parts.dwUrlPathLength != 0 || parts.dwExtraInfoLength != 0) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    const bool is_secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
    if (!is_secure && parts.nScheme != INTERNET_SCHEME_HTTP) {
        return std::unexpected(error{.code = error_code::unsupported});
    }
    void* const session = WinHttpOpen(
        L"lucent-loader",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0
    );
    if (session == nullptr) {
        return std::unexpected(system_failure());
    }
    WinHttpSetTimeouts(
        session, connect_timeout_ms, connect_timeout_ms, connect_timeout_ms, receive_timeout_ms
    );
    // Only TLS 1.2 and later, whatever the system's defaults allow.
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
    WinHttpSetOption(session, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols));
    void* const connection = WinHttpConnect(session, host.data(), parts.nPort, 0);
    if (connection == nullptr) {
        const error failure = system_failure();
        WinHttpCloseHandle(session);
        return std::unexpected(failure);
    }
    const scheme used = is_secure ? scheme::https : scheme::http;
    return client{
        std::string{origin}, native_handles{.session = session, .connection = connection}, used
    };
}

client::client(std::string origin, native_handles handles, scheme used)
    : m_origin{std::move(origin)}
    , m_session{handles.session}
    , m_connection{handles.connection}
    , m_scheme{used} {}

client::client(client&& other) noexcept
    : m_origin{std::move(other.m_origin)}
    , m_session{std::exchange(other.m_session, nullptr)}
    , m_connection{std::exchange(other.m_connection, nullptr)}
    , m_scheme{other.m_scheme} {}

client::~client() {
    if (m_connection != nullptr) {
        WinHttpCloseHandle(m_connection);
    }
    if (m_session != nullptr) {
        WinHttpCloseHandle(m_session);
    }
}

auto client::origin() const -> std::string_view {
    return m_origin;
}

auto client::send(const request& asked, usize max_body) -> result<response> {
    std::vector<std::byte> body;
    const auto keep = [&body](std::span<const std::byte> piece) -> result<void> {
        body.insert(body.end(), piece.begin(), piece.end());
        return {};
    };
    response answered = LUCENT_TRY(stream(asked, max_body, keep));
    if (answered.body.empty()) {
        answered.body = std::move(body);
    }
    return answered;
}

auto client::stream(const request& asked, usize max_body, body_sink sink) -> result<response> {
    const std::wstring method = to_wide(asked.method);
    const std::wstring path = to_wide(asked.path);
    const request_handle handle{WinHttpOpenRequest(
        m_connection,
        method.c_str(),
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        m_scheme == scheme::https ? WINHTTP_FLAG_SECURE : 0
    )};
    if (handle.native() == nullptr) {
        return std::unexpected(system_failure());
    }
    // A redirect would carry the DPoP proof to a URL it doesn't name; the server never sends one.
    DWORD never = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    WinHttpSetOption(handle.native(), WINHTTP_OPTION_REDIRECT_POLICY, &never, sizeof(never));
    const std::wstring headers = header_block(asked.headers);
    // WinHTTP takes LPVOID for the body but only reads it.
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-const-cast): the API is not const-correct.
    void* const body = const_cast<std::byte*>(asked.body.data());
    const BOOL sent = WinHttpSendRequest(
        handle.native(),
        headers.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : headers.c_str(),
        narrow<DWORD>(headers.size()),
        body,
        narrow<DWORD>(asked.body.size()),
        narrow<DWORD>(asked.body.size()),
        0
    );
    if (sent == FALSE || WinHttpReceiveResponse(handle.native(), nullptr) == FALSE) {
        return std::unexpected(system_failure());
    }
    response answered{
        .status = query_number(handle.native(), WINHTTP_QUERY_STATUS_CODE).value_or(0),
        .body = {},
        .date = query_date(handle.native()),
        .retry_after = std::nullopt,
    };
    if (const std::optional<DWORD> retry =
            query_number(handle.native(), WINHTTP_QUERY_RETRY_AFTER)) {
        answered.retry_after = narrow<i64>(*retry);
    }
    if (answered.status >= 200 && answered.status < 300) {
        LUCENT_TRY(read_body(handle.native(), max_body, sink));
        return answered;
    }
    const auto keep = [&answered](std::span<const std::byte> piece) -> result<void> {
        answered.body.insert(answered.body.end(), piece.begin(), piece.end());
        return {};
    };
    LUCENT_TRY(read_body(handle.native(), max_body, keep));
    return answered;
}

}
