#include <algorithm>
#include <concepts>
#include <cstddef>
#include <span>
#include <vector>

#include <lucent/fuzzing/run_one.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>
#include <lucent/wire/start.hpp>

// Every /v1 decoder over arbitrary bytes; the contexts differ, so at most one accepts a given
// input. The messages are canonical, so whatever decodes must encode back to exactly the input,
// and the encoder's own canonical checks must hold for it. Seed with contracts/wire/v1/*.bin.

namespace lucent::fuzzing {
namespace {

// Runs one decoder and, when it accepts, checks the input comes back from its encoder.
template <std::move_constructible Message>
auto check_round_trip(
    std::span<const std::byte> input,
    auto (*decode)(std::span<const std::byte>)->result<Message>,
    auto (*encode)(const Message&)->std::vector<std::byte>
) -> void {
    const result<Message> decoded = decode(input);
    if (!decoded) {
        return;
    }
    const std::vector<std::byte> encoded = encode(*decoded);
    LUCENT_INVARIANT(std::ranges::equal(encoded, input));
}

}

auto run_one(std::span<const std::byte> input) -> void {
    check_round_trip(input, wire::decode_session_hello, wire::encode_session_hello);
    check_round_trip(input, wire::decode_session_exchange, wire::encode_session_exchange);
    check_round_trip(input, wire::decode_session_reply, wire::encode_session_reply);
    check_round_trip(input, wire::decode_frame, wire::encode_frame);
    check_round_trip(input, wire::decode_lease, wire::encode_lease);
    check_round_trip(input, wire::decode_lease_renewal, wire::encode_lease_renewal);
    check_round_trip(input, wire::decode_lease_request, wire::encode_lease_request);
    check_round_trip(input, wire::decode_lease_response, wire::encode_lease_response);
    check_round_trip(input, wire::decode_start_request, wire::encode_start_request);
    check_round_trip(input, wire::decode_start_reply, wire::encode_start_reply);
    check_round_trip(input, wire::decode_enrollment_request, wire::encode_enrollment_request);
    check_round_trip(input, wire::decode_enrollment_status, wire::encode_enrollment_status);
    check_round_trip(input, wire::decode_refusal, wire::encode_refusal);
}

}
