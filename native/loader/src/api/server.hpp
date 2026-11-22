#pragma once

#include <chrono>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

#include <lucent/wire/refusal.hpp>

#include "cng/device_key.hpp"
#include "http/client.hpp"
#include "text/json.hpp"

// The native /v1 listener as the loader calls it: every request with its DPoP proof, binary
// bodies, the refusal body on every refusal (platform/server/src/native/app.ts).

namespace lucent::loader {

// A 2xx body, or why the server refused.
using answer = std::variant<std::vector<std::byte>, wire::refusal>;

// Whether a write carries an operation id, which makes a retry return the first answer.
enum class operation : u8 { none, fresh };

struct call {
    std::string_view method;
    // From the origin, starting with "/v1/".
    std::string_view path;
    std::optional<std::string_view> access_token;
    std::span<const std::byte> body;
    operation kind = operation::none;
    usize max_body = usize{1} << 20U;
    // Each try's, of the two a refused proof allows; none for the client's own.
    std::optional<std::chrono::milliseconds> receive_timeout = std::nullopt;
};

// The two OAuth endpoints answer in OAuth's words: a status and a JSON object.
struct oauth_answer {
    u32 status = 0;
    json_object body;
};

class server final {
public:
    // The key is borrowed for the server's lifetime.
    server(http::client link, const device_key& key);

    // Fails only when the server couldn't be reached or sent what no server of ours sends; any
    // refusal is an answer.
    auto send(const call& asked) -> result<answer>;

    // A form POST to /v1/auth/requests or /v1/auth/token.
    auto send_form(std::string_view path, std::string_view form) -> result<oauth_answer>;

    // A GET whose 2xx body goes to the sink as it arrives; nothing on success, else the refusal.
    auto stream(const call& asked, http::body_sink sink) -> result<std::optional<wire::refusal>>;

    auto origin() const -> std::string_view;

private:
    struct prepared;

    auto prepare(const call& asked, std::string_view operation_id) -> result<prepared>;
    // Sends once, and once more after correcting the clock when the proof was refused and the
    // server's Date says ours is off: platform/server/src/native/dpop.ts allows 5 s ahead and
    // 300 s behind.
    auto exchange(const call& asked, http::body_sink sink) -> result<http::response>;
    auto is_clock_off(const http::response& answered) -> bool;

    http::client m_link;
    const device_key* m_key;
    // The server's clock minus ours, in seconds, learned from its Date header.
    i64 m_clock_offset = 0;
};

// What a non-2xx body says: the refusal it carries, or SERVICE_UNAVAILABLE for anything that isn't
// one (a proxy's error page, say).
auto refusal_of(const http::response& answered) -> wire::refusal;

// The refusal an answer carries, if it is one.
auto refusal_in(const answer& answered) -> std::optional<wire::refusal>;

// An answer's body, borrowed from it; empty for a refusal.
auto body_in(const answer& answered) -> std::span<const std::byte>;

}
