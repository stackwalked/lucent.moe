#include "account/callback.hpp"

#include <array>
#include <chrono>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <WS2tcpip.h>
#include <WinSock2.h>

#include <lucent/core/narrow.hpp>

namespace lucent::loader {
namespace {

// A request line and a browser's headers fit well inside this; more isn't a callback.
constexpr usize max_head_size = usize{8} << 10U;
// A browser that connects and then says nothing is cut off, so the wait keeps its own clock.
constexpr DWORD read_timeout_ms = 5000;
constexpr SOCKET no_socket = INVALID_SOCKET;

constexpr std::string_view answer_page =
    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
    "Connection: close\r\n\r\n<!doctype html><title>lucent</title><p>back to the loader: this "
    "window can be closed.";
constexpr std::string_view not_found_page =
    "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

auto socket_failure() -> error {
    return error{.code = error_code::system, .system_code = narrow<u32>(WSAGetLastError())};
}

auto hex_value(char digit) -> std::optional<u32> {
    if (digit >= '0' && digit <= '9') {
        return static_cast<u32>(digit - '0');
    }
    if (digit >= 'a' && digit <= 'f') {
        return static_cast<u32>(digit - 'a' + 10);
    }
    if (digit >= 'A' && digit <= 'F') {
        return static_cast<u32>(digit - 'A' + 10);
    }
    return std::nullopt;
}

// application/x-www-form-urlencoded's decoding: '+' is a space, %XX a byte.
auto form_decoded(std::string_view text) -> result<std::string> {
    std::string decoded;
    for (usize at = 0; at < text.size(); ++at) {
        const char letter = text.at(at);
        if (letter == '+') {
            decoded.push_back(' ');
        } else if (letter == '%') {
            if (text.size() - at < 3) {
                return std::unexpected(error{.code = error_code::malformed});
            }
            const std::optional<u32> high = hex_value(text.at(at + 1));
            const std::optional<u32> low = hex_value(text.at(at + 2));
            if (!high || !low) {
                return std::unexpected(error{.code = error_code::malformed});
            }
            decoded.push_back(static_cast<char>((*high << 4U) | *low));
            at += 2;
        } else {
            decoded.push_back(letter);
        }
    }
    return decoded;
}

struct callback_query {
    std::optional<std::string> code;
    std::optional<std::string> error_name;
    std::optional<std::string> state;
};

auto slot_of(callback_query& found, std::string_view name) -> std::optional<std::string>* {
    if (name == "code") {
        return &found.code;
    }
    if (name == "error") {
        return &found.error_name;
    }
    if (name == "state") {
        return &found.state;
    }
    return nullptr;
}

// Each of the three at most once; others are ignored, as OAuth allows.
auto query_of(std::string_view query) -> result<callback_query> {
    callback_query found;
    while (!query.empty()) {
        const usize end = query.find('&');
        const std::string_view pair = query.substr(0, end);
        query = end == std::string_view::npos ? std::string_view{} : query.substr(end + 1);
        const usize equals = pair.find('=');
        if (equals == std::string_view::npos) {
            continue;
        }
        const std::string_view name = pair.substr(0, equals);
        std::optional<std::string>* const slot = slot_of(found, name);
        if (slot == nullptr) {
            continue;
        }
        if (slot->has_value()) {
            return std::unexpected(error{.code = error_code::malformed});
        }
        *slot = LUCENT_TRY(form_decoded(pair.substr(equals + 1)));
    }
    return found;
}

auto close_socket(uptr handle) -> void {
    closesocket(static_cast<SOCKET>(handle));
}

// One connection's request head, read until the blank line or the bound.
auto read_head(SOCKET connection) -> result<std::string> {
    std::string head;
    std::array<char, 1024> piece{};
    while (!head.contains("\r\n\r\n")) {
        const i32 got = recv(connection, piece.data(), narrow<i32>(piece.size()), 0);
        if (got <= 0) {
            return std::unexpected(socket_failure());
        }
        head.append(piece.data(), narrow<usize>(got));
        if (head.size() > max_head_size) {
            return std::unexpected(error{.code = error_code::malformed});
        }
    }
    return head;
}

auto send_all(SOCKET connection, std::span<const char> text) -> void {
    // Best effort: the browser's page is a courtesy, the code is already read.
    send(connection, text.data(), narrow<i32>(text.size()), 0);
}

}

auto parse_callback_request(std::string_view head) -> result<callback_result> {
    const usize line_end = head.find("\r\n");
    const std::string_view line = head.substr(0, line_end);
    constexpr std::string_view prefix = "GET /callback?";
    constexpr std::string_view version = " HTTP/1.1";
    if (!line.starts_with(prefix) || !line.ends_with(version)) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    const std::string_view query =
        line.substr(prefix.size(), line.size() - prefix.size() - version.size());
    callback_query found = LUCENT_TRY(query_of(query));
    if (!found.state || found.code.has_value() == found.error_name.has_value()) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    if (found.code) {
        return authorized{.code = *std::move(found.code), .state = *std::move(found.state)};
    }
    return denied{.state = *std::move(found.state)};
}

auto callback_listener::open() -> result<callback_listener> {
    WSADATA started{};
    const i32 startup = WSAStartup(MAKEWORD(2, 2), &started);
    if (startup != 0) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = narrow<u32>(startup)}
        );
    }
    const SOCKET listening = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (listening == no_socket) {
        const error failure = socket_failure();
        WSACleanup();
        return std::unexpected(failure);
    }
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = 0;
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): Winsock's sockaddr is the C idiom of a common prefix.
    auto* const generic = reinterpret_cast<sockaddr*>(&address);
    i32 size = narrow<i32>(sizeof(address));
    if (bind(listening, generic, size) == SOCKET_ERROR
        || listen(listening, 4) == SOCKET_ERROR
        || getsockname(listening, generic, &size) == SOCKET_ERROR) {
        const error failure = socket_failure();
        closesocket(listening);
        WSACleanup();
        return std::unexpected(failure);
    }
    return callback_listener{
        bound_socket{.socket = static_cast<uptr>(listening), .port = ntohs(address.sin_port)}
    };
}

callback_listener::callback_listener(bound_socket bound)
    : m_socket{bound.socket}
    , m_port{bound.port} {}

callback_listener::callback_listener(callback_listener&& other) noexcept
    : m_socket{std::exchange(other.m_socket, static_cast<uptr>(no_socket))}
    , m_port{other.m_port} {}

callback_listener::~callback_listener() {
    if (m_socket != static_cast<uptr>(no_socket)) {
        close_socket(m_socket);
        WSACleanup();
    }
}

auto callback_listener::port() const -> u16 {
    return m_port;
}

auto callback_listener::redirect_uri() const -> std::string {
    return std::format("http://127.0.0.1:{}/callback", m_port);
}

auto callback_listener::wait(std::chrono::seconds patience) const -> result<callback_result> {
    const auto deadline = std::chrono::steady_clock::now() + patience;
    const auto listening = static_cast<SOCKET>(m_socket);
    while (true) {
        const auto left = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now()
        );
        if (left.count() <= 0) {
            return std::unexpected(error{.code = error_code::timed_out});
        }
        WSAPOLLFD polled{.fd = listening, .events = POLLRDNORM, .revents = 0};
        const i32 ready = WSAPoll(&polled, 1, narrow<INT>(left.count()));
        if (ready == SOCKET_ERROR) {
            return std::unexpected(socket_failure());
        }
        if (ready == 0) {
            continue;
        }
        const SOCKET connection = accept(listening, nullptr, nullptr);
        if (connection == no_socket) {
            continue;
        }
        DWORD timeout = read_timeout_ms;
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): setsockopt takes the option as bytes.
        const auto* const option = reinterpret_cast<const char*>(&timeout);
        setsockopt(connection, SOL_SOCKET, SO_RCVTIMEO, option, sizeof(timeout));
        const result<std::string> head = read_head(connection);
        const result<callback_result> parsed =
            head ? parse_callback_request(*head) : std::unexpected(head.error());
        send_all(connection, parsed ? answer_page : not_found_page);
        closesocket(connection);
        if (parsed) {
            return *parsed;
        }
    }
}

}
