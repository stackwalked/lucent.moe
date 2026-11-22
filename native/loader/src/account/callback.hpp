#pragma once

#include <chrono>
#include <string>
#include <string_view>
#include <variant>

// The loopback end of sign-in (RFC 8252 §7.3): the browser comes back to
// http://127.0.0.1:<port>/callback with the code, or with access_denied, and the state the loader
// sent. One request is read and answered; nothing else is served.

namespace lucent::loader {

struct authorized {
    std::string code;
    std::string state;

    auto operator==(const authorized&) const -> bool = default;
};

struct denied {
    std::string state;

    auto operator==(const denied&) const -> bool = default;
};

using callback_result = std::variant<authorized, denied>;

// The request line and headers of one HTTP request, as far as the blank line. Only
// `GET /callback?...` with a code or an error, and a state, is a callback; anything else
// (a favicon, a probe) is not_found, and the listener keeps waiting.
auto parse_callback_request(std::string_view head) -> result<callback_result>;

// A listening socket on 127.0.0.1 at a port the system picked.
class callback_listener final {
public:
    static auto open() -> result<callback_listener>;

    callback_listener(const callback_listener&) = delete ("one owner per socket");
    auto operator=(const callback_listener&)
        -> callback_listener& = delete ("one owner per socket");
    callback_listener(callback_listener&& other) noexcept;
    auto operator=(callback_listener&&) -> callback_listener& = delete ("bound to its port");
    ~callback_listener();

    auto port() const -> u16;

    // The redirect_uri sign-in registers: http://127.0.0.1:<port>/callback.
    auto redirect_uri() const -> std::string;

    // Waits for the browser's callback, answering each request it reads; fails as timed_out.
    auto wait(std::chrono::seconds patience) const -> result<callback_result>;

private:
    struct bound_socket {
        uptr socket;
        u16 port;
    };

    explicit callback_listener(bound_socket bound);

    uptr m_socket;
    u16 m_port;
};

}
