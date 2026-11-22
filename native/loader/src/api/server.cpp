#include "api/server.hpp"

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

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/wire/refusal.hpp>

#include "api/dpop.hpp"
#include "cng/device_key.hpp"
#include "cng/random.hpp"
#include "http/client.hpp"
#include "text/json.hpp"
#include "text/text_bytes.hpp"

namespace lucent::loader {
namespace {

// The OAuth replies are a few hundred bytes; the token reply is the largest.
constexpr usize max_oauth_body = usize{16} << 10U;
// 16 random bytes: 22 base64url characters, inside both the jti's and the operation id's ranges.
constexpr usize random_id_bytes = 16;
// Seconds the local clock may stray before a refused proof is worth one retry with the server's.
constexpr i64 tolerated_drift = 2;

// build: FILETIME counts 100 ns intervals from 1601-01-01; the Unix epoch is 11644473600 s later
// found: the FILETIME documentation
// breaks: every proof's iat is off by centuries, refused
constexpr i64 filetime_ticks_per_second = 10'000'000;
constexpr i64 unix_epoch_in_filetime_seconds = 11'644'473'600;

// The wall clock, read here alone: DPoP's iat is wall time by definition, and the server's Date
// corrects it.
auto unix_seconds_now() -> i64 {
    FILETIME now{};
    GetSystemTimePreciseAsFileTime(&now);
    const u64 ticks = (u64{now.dwHighDateTime} << 32U) | now.dwLowDateTime;
    return (narrow<i64>(ticks) / filetime_ticks_per_second) - unix_epoch_in_filetime_seconds;
}

auto is_success(u32 status) -> bool {
    return status >= 200 && status < 300;
}

}

struct server::prepared {
    std::string proof;
    std::string authorization;
    std::string operation_id;
};

server::server(http::client link, const device_key& key)
    : m_link{std::move(link)}
    , m_key{&key} {}

auto server::origin() const -> std::string_view {
    return m_link.origin();
}

auto server::prepare(const call& asked, std::string_view operation_id) -> result<prepared> {
    const std::string url = std::string{m_link.origin()}.append(asked.path);
    const std::string proof_id = random_token(random_id_bytes);
    prepared made{
        .proof = LUCENT_TRY(dpop_proof(
            *m_key,
            proof_claims{
                .method = asked.method,
                .url = url,
                .access_token = asked.access_token,
                .issued_at = unix_seconds_now() + m_clock_offset,
                .proof_id = proof_id,
            }
        )),
        .authorization = {},
        .operation_id = std::string{operation_id},
    };
    if (asked.access_token) {
        made.authorization = std::string{"DPoP "}.append(*asked.access_token);
    }
    return made;
}

auto server::is_clock_off(const http::response& answered) -> bool {
    if (answered.status != 401 || !answered.date) {
        return false;
    }
    const wire::refusal refused = refusal_of(answered);
    if (refused.code != wire::refusal_code::proof_invalid) {
        return false;
    }
    const i64 offset = *answered.date - unix_seconds_now();
    if (offset - m_clock_offset < tolerated_drift && m_clock_offset - offset < tolerated_drift) {
        return false;
    }
    m_clock_offset = offset;
    return true;
}

auto server::exchange(const call& asked, http::body_sink sink) -> result<http::response> {
    // One id for both tries: a retry of a write returns the first answer, never a second write.
    const std::string operation_id =
        asked.kind == operation::fresh ? random_token(random_id_bytes) : std::string{};
    http::response answered;
    for (i32 attempt = 0; attempt < 2; ++attempt) {
        const prepared made = LUCENT_TRY(prepare(asked, operation_id));
        std::vector<http::header> headers{
            http::header{.name = "DPoP", .value = made.proof},
            http::header{.name = "Content-Type", .value = "application/octet-stream"},
        };
        if (!made.authorization.empty()) {
            headers.push_back(http::header{.name = "Authorization", .value = made.authorization});
        }
        if (!made.operation_id.empty()) {
            headers.push_back(http::header{.name = "Lucent-Operation", .value = made.operation_id});
        }
        answered = LUCENT_TRY(m_link.stream(
            http::request{
                .method = asked.method,
                .path = asked.path,
                .headers = headers,
                .body = asked.body,
            },
            asked.max_body,
            sink
        ));
        if (!is_clock_off(answered)) {
            break;
        }
    }
    return answered;
}

auto server::send(const call& asked) -> result<answer> {
    std::vector<std::byte> body;
    const auto keep = [&body](std::span<const std::byte> piece) -> result<void> {
        body.insert(body.end(), piece.begin(), piece.end());
        return {};
    };
    const http::response answered = LUCENT_TRY(exchange(asked, keep));
    if (!is_success(answered.status)) {
        return answer{refusal_of(answered)};
    }
    return answer{std::move(body)};
}

auto server::stream(const call& asked, http::body_sink sink)
    -> result<std::optional<wire::refusal>> {
    const http::response answered = LUCENT_TRY(exchange(asked, sink));
    if (!is_success(answered.status)) {
        return refusal_of(answered);
    }
    return std::nullopt;
}

auto server::send_form(std::string_view path, std::string_view form) -> result<oauth_answer> {
    const std::string url = std::string{m_link.origin()}.append(path);
    http::response answered;
    for (i32 attempt = 0; attempt < 2; ++attempt) {
        const std::string proof_id = random_token(random_id_bytes);
        const std::string proof = LUCENT_TRY(dpop_proof(
            *m_key,
            proof_claims{
                .method = "POST",
                .url = url,
                .access_token = std::nullopt,
                .issued_at = unix_seconds_now() + m_clock_offset,
                .proof_id = proof_id,
            }
        ));
        const std::array headers{
            http::header{.name = "DPoP", .value = proof},
            http::header{.name = "Content-Type", .value = "application/x-www-form-urlencoded"},
        };
        answered = LUCENT_TRY(m_link.send(
            http::request{
                .method = "POST",
                .path = path,
                .headers = headers,
                .body = std::as_bytes(std::span{form}),
            },
            max_oauth_body
        ));
        // OAuth's endpoints say a bad proof in their own words (RFC 9449 §7.1), so the clock is
        // corrected on any 400 that carries invalid_dpop_proof.
        const result<json_object> parsed = parse_flat_object(as_text(answered.body));
        const bool is_proof_refused = answered.status == 400
                                      && parsed
                                      && string_member(*parsed, "error") == "invalid_dpop_proof";
        if (!is_proof_refused || !answered.date || attempt == 1) {
            if (!parsed) {
                return std::unexpected(parsed.error());
            }
            return oauth_answer{.status = answered.status, .body = *parsed};
        }
        m_clock_offset = *answered.date - unix_seconds_now();
    }
    return std::unexpected(error{.code = error_code::malformed});
}

auto refusal_of(const http::response& answered) -> wire::refusal {
    const result<wire::refusal> decoded = wire::decode_refusal(answered.body);
    if (!decoded) {
        return wire::refusal{.code = wire::refusal_code::service_unavailable, .retry_after = {}};
    }
    return *decoded;
}

auto refusal_in(const answer& answered) -> std::optional<wire::refusal> {
    return match(
        answered,
        [](const std::vector<std::byte>& /*body*/) { return std::optional<wire::refusal>{}; },
        [](const wire::refusal& refused) { return std::optional<wire::refusal>{refused}; }
    );
}

auto body_in(const answer& answered) -> std::span<const std::byte> {
    return match(
        answered,
        [](const std::vector<std::byte>& body) -> std::span<const std::byte> { return body; },
        [](const wire::refusal& /*refused*/) -> std::span<const std::byte> { return {}; }
    );
}

}
