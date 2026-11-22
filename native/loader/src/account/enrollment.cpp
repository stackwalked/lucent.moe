#include "account/enrollment.hpp"

#include <chrono>
#include <cstddef>
#include <format>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/refusal.hpp>

#include "api/dpop.hpp"
#include "api/server.hpp"
#include "cng/device_key.hpp"
#include "text/base64url.hpp"

namespace lucent::loader {
namespace {

// The platform rate-limits reads at 60 a minute per key; every 3 s stays well inside it.
constexpr std::chrono::seconds poll_interval{3};

// One read of the enrollment: the refusal that came instead, or else its status.
struct enrollment_read {
    std::optional<wire::refusal> refusal;
    wire::enrollment_status status;
};

auto status_of(const answer& answered) -> result<enrollment_read> {
    return match(
        answered,
        [](const std::vector<std::byte>& body) -> result<enrollment_read> {
            const wire::enrollment_status status = LUCENT_TRY(wire::decode_enrollment_status(body));
            return enrollment_read{.refusal = std::nullopt, .status = status};
        },
        [](const wire::refusal& refused) -> result<enrollment_read> {
            return enrollment_read{.refusal = refused, .status = wire::enrollment_status{}};
        }
    );
}

}

auto enroll(server& api, const device_key& key, token_source token, show_match_code show)
    -> result<enrollment_outcome> {
    const std::vector<std::byte> body =
        wire::encode_enrollment_request(wire::enrollment_request{.storage = key.storage()});
    const std::string first_token = LUCENT_TRY(token());
    const answer asked = LUCENT_TRY(api.send(
        call{
            .method = "POST",
            .path = "/v1/enrollments",
            .access_token = first_token,
            .body = body,
            .kind = operation::fresh,
        }
    ));
    enrollment_read read = LUCENT_TRY(status_of(asked));
    if (read.refusal) {
        if (read.refusal->code == wire::refusal_code::already_enrolled) {
            return enrolled{};
        }
        return *read.refusal;
    }
    const std::string path =
        std::format("/v1/enrollments/{}", to_hex(read.status.enrollment.bytes));
    show(match_code_of(key.public_point()));
    while (true) {
        switch (read.status.state) {
        case wire::enrollment_state::approved:
            return enrolled{};
        case wire::enrollment_state::denied:
        case wire::enrollment_state::expired:
            return not_approved{.state = read.status.state};
        case wire::enrollment_state::pending:
            break;
        }
        std::this_thread::sleep_for(poll_interval);
        const std::string fresh = LUCENT_TRY(token());
        const answer polled = LUCENT_TRY(api.send(
            call{
                .method = "GET",
                .path = path,
                .access_token = fresh,
                .body = {},
                .kind = operation::none
            }
        ));
        read = LUCENT_TRY(status_of(polled));
        if (read.refusal) {
            return *read.refusal;
        }
    }
}

}
