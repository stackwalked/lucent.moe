#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/core/stdx/function_ref.hpp>

// HTTP through WinHTTP: the system's TLS, proxy settings and certificate store, so the loader
// carries no TLS stack of its own. One origin per client, no redirects followed, every body
// bounded.

namespace lucent::loader::http {

struct header {
    std::string_view name;
    std::string_view value;
};

struct request {
    std::string_view method;
    // From the origin, starting with '/'.
    std::string_view path;
    std::span<const header> headers;
    std::span<const std::byte> body;
};

struct response {
    u32 status = 0;
    // Empty when the body went to a stream's sink.
    std::vector<std::byte> body;
    // The server's Date header, in seconds since the Unix epoch, when it sent a valid one.
    std::optional<i64> date;
    // Retry-After in seconds, when it sent one.
    std::optional<i64> retry_after;
};

// Takes each piece of a body as it arrives.
using body_sink = stdx::function_ref<result<void>(std::span<const std::byte>)>;

class client final {
public:
    // An http or https origin and nothing else ("https://api.lucent.moe").
    static auto open(std::string_view origin) -> result<client>;

    client(const client&) = delete ("one WinHTTP session per client");
    auto operator=(const client&) -> client& = delete ("one WinHTTP session per client");
    client(client&& other) noexcept;
    auto operator=(client&&) -> client& = delete ("a client is bound to its origin");
    ~client();

    auto origin() const -> std::string_view;

    // The whole body, refused as unsupported past the bound. Fails as error_code::system when the
    // server can't be reached; any status is a response.
    auto send(const request& asked, usize max_body) -> result<response>;

    // A 2xx body goes to the sink as it arrives, bounded in total; any other status is buffered as
    // send would, so a refusal can be read.
    auto stream(const request& asked, usize max_body, body_sink sink) -> result<response>;

private:
    struct native_handles {
        void* session;
        void* connection;
    };

    enum class scheme : u8 { http, https };

    client(std::string origin, native_handles handles, scheme used);

    std::string m_origin;
    void* m_session;
    void* m_connection;
    scheme m_scheme;
};

}
