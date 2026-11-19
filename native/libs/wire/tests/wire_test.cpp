#include <algorithm>
#include <array>
#include <chrono>
#include <concepts>
#include <cstddef>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>
#include <lucent/wire/start.hpp>

#include "fixtures.hpp"

// The refusals change encoded bytes at offsets written out here, so they state the layout
// independently of the encoder, which refuses to write anything that isn't canonical.

namespace lucent::wire {
namespace {

using decoder = auto (*)(std::span<const std::byte>) -> std::optional<error_code>;

// Nothing when the bytes decode.
template <std::move_constructible T>
auto error_of(result<T> decoded) -> std::optional<error_code> {
    return decoded ? std::nullopt : std::optional{decoded.error().code};
}

struct message {
    std::string_view name;
    std::vector<std::byte> bytes;
    decoder decode;
};

auto messages() -> std::vector<message> {
    return {
        message{
            .name = "session hello",
            .bytes = encode_session_hello(fixtures::hello()),
            .decode = [](auto bytes) { return error_of(decode_session_hello(bytes)); },
        },
        message{
            .name = "session exchange",
            .bytes = encode_session_exchange(fixtures::exchange()),
            .decode = [](auto bytes) { return error_of(decode_session_exchange(bytes)); },
        },
        message{
            .name = "lease",
            .bytes = encode_lease(fixtures::first_lease()),
            .decode = [](auto bytes) { return error_of(decode_lease(bytes)); },
        },
        message{
            .name = "lease renewal",
            .bytes = encode_lease_renewal(fixtures::renewal()),
            .decode = [](auto bytes) { return error_of(decode_lease_renewal(bytes)); },
        },
        message{
            .name = "start request",
            .bytes = encode_start_request(fixtures::request()),
            .decode = [](auto bytes) { return error_of(decode_start_request(bytes)); },
        },
        message{
            .name = "start reply",
            .bytes = encode_start_reply(fixtures::start_reply_of()),
            .decode = [](auto bytes) { return error_of(decode_start_reply(bytes)); },
        },
        message{
            .name = "enrollment request",
            .bytes = encode_enrollment_request(enrollment_request{.storage = key_storage::tpm}),
            .decode = [](auto bytes) { return error_of(decode_enrollment_request(bytes)); },
        },
        message{
            .name = "enrollment status",
            .bytes = encode_enrollment_status(
                enrollment_status{
                    .enrollment = fixtures::enrollment,
                    .state = enrollment_state::approved,
                    .device = fixtures::device,
                }
            ),
            .decode = [](auto bytes) { return error_of(decode_enrollment_status(bytes)); },
        },
        message{
            .name = "refusal",
            .bytes = encode_refusal(
                refusal{
                    .code = refusal_code::rate_limited,
                    .retry_after = std::chrono::milliseconds{1000},
                }
            ),
            .decode = [](auto bytes) { return error_of(decode_refusal(bytes)); },
        },
    };
}

auto with_byte(std::vector<std::byte> bytes, usize offset, u8 value) -> std::vector<std::byte> {
    bytes.at(offset) = std::byte{value};
    return bytes;
}

auto with_bytes(std::vector<std::byte> bytes, usize offset, std::span<const std::byte> value)
    -> std::vector<std::byte> {
    std::ranges::copy(value, bytes.begin() + static_cast<isize>(offset));
    return bytes;
}

auto little_u64(u64 value) -> std::array<std::byte, 8> {
    std::array<std::byte, 8> out{};
    for (usize index = 0; index < out.size(); ++index) {
        out.at(index) = static_cast<std::byte>((value >> (8U * index)) & 0xffU);
    }
    return out;
}

constexpr std::optional<error_code> malformed = error_code::malformed;

TEST_CASE("every message's encoding decodes, and no prefix of it or extension of it does") {
    for (const message& each : messages()) {
        INFO(each.name);
        CHECK(each.decode(each.bytes) == std::nullopt);
        for (usize size = 0; size < each.bytes.size(); ++size) {
            CHECK(each.decode(std::span{each.bytes}.first(size)) == malformed);
        }
        std::vector<std::byte> extended = each.bytes;
        extended.push_back(std::byte{0});
        CHECK(each.decode(extended) == malformed);
    }
}

TEST_CASE("a message under another kind's context is malformed, its own at v2 a version mismatch") {
    const std::vector<std::byte> lease = encode_lease(fixtures::first_lease());
    const std::vector<std::byte> renewal = encode_lease_renewal(fixtures::renewal());
    // "lucent lease v1" is followed by NUL padding; offset 14 is its version digit.
    const std::vector<std::byte> lease_v2 = with_byte(lease, 14, '2');
    const std::vector<std::byte> unpadded = with_byte(lease, 31, 'x');

    CHECK(error_of(decode_lease(renewal)) == malformed);
    CHECK(error_of(decode_lease_renewal(lease)) == malformed);
    CHECK(error_of(decode_lease(lease_v2)) == error_code::version_mismatch);
    CHECK(error_of(decode_lease(unpadded)) == error_code::version_mismatch);
}

TEST_CASE("a session hello with an unknown image kind or a non-canonical X25519 key is malformed") {
    const std::vector<std::byte> hello = encode_session_hello(fixtures::hello());
    // 2^255 - 19 and 2^255 - 1: the first two keys at or above the prime.
    std::array<std::byte, 32> prime{};
    prime.fill(std::byte{0xff});
    prime.front() = std::byte{0xed};
    prime.back() = std::byte{0x7f};
    std::array<std::byte, 32> top{};
    top.fill(std::byte{0xff});

    CHECK(error_of(decode_session_hello(with_byte(hello, 100, 2))) == malformed);
    CHECK(error_of(decode_session_hello(with_bytes(hello, 32, prime))) == malformed);
    CHECK(error_of(decode_session_hello(with_bytes(hello, 32, top))) == malformed);
}

// Whether the bytes decode as a frame that opens under the renewal frame's key.
auto is_openable(std::span<const std::byte> bytes) -> bool {
    const result<frame> decoded = decode_frame(bytes);
    return decoded && open_frame(fixtures::keys().module_to_server, *decoded).has_value();
}

TEST_CASE("a frame cut short of its header and tag is malformed") {
    const std::vector<std::byte> sealed = encode_frame(fixtures::renewal_frame());
    const std::vector<std::byte> reply = encode_session_reply(fixtures::reply());

    for (usize size = 0; size < 81 + crypto::aead_tag_size; ++size) {
        CHECK(error_of(decode_frame(std::span{sealed}.first(size))) == malformed);
    }
    CHECK(error_of(decode_session_reply(std::span{reply}.first(191))) == malformed);
}

// The frame and the session reply ending in one run to the end of the body that carries them, so
// cutting or extending one past its header is caught by the tag, not by the decoder.
TEST_CASE("a frame cut or extended past its header never opens") {
    const std::vector<std::byte> sealed = encode_frame(fixtures::renewal_frame());
    std::vector<std::byte> extended = sealed;
    extended.push_back(std::byte{0});

    CHECK(is_openable(sealed));
    for (usize size = 81 + crypto::aead_tag_size; size < sealed.size(); ++size) {
        CHECK_FALSE(is_openable(std::span{sealed}.first(size)));
    }
    CHECK_FALSE(is_openable(extended));
}

TEST_CASE("a frame with an unknown direction or no room for a tag is malformed") {
    const std::vector<std::byte> sealed = encode_frame(fixtures::renewal_frame());
    const std::vector<std::byte> tagless{sealed.begin(), sealed.begin() + 81 + 15};

    CHECK(error_of(decode_frame(with_byte(sealed, 48, 0))) == malformed);
    CHECK(error_of(decode_frame(with_byte(sealed, 48, 3))) == malformed);
    CHECK(error_of(decode_frame(tagless)) == malformed);
}

TEST_CASE("a session reply whose frame runs the wrong way or names another session is malformed") {
    const std::vector<std::byte> reply = encode_session_reply(fixtures::reply());
    // The frame starts after the 192-byte exchange: its session at 224, its direction at 240.
    CHECK(error_of(decode_session_reply(with_byte(reply, 240, 1))) == malformed);
    CHECK(error_of(decode_session_reply(with_byte(reply, 224, 0x12))) == malformed);
}

TEST_CASE("a lease with a zero duration or challenge, or a bad product, is malformed") {
    const std::vector<std::byte> lease = encode_lease(fixtures::first_lease());
    const std::array<std::byte, 4> zero{};

    CHECK(error_of(decode_lease(with_bytes(lease, 104, zero))) == malformed);
    CHECK(error_of(decode_lease(with_bytes(lease, 136, zero))) == malformed);
    CHECK(error_of(decode_lease(with_byte(lease, 141, 'C'))) == malformed);
    CHECK(error_of(decode_lease(with_byte(lease, 141, '_'))) == malformed);
    CHECK(error_of(decode_lease(with_byte(lease, 140, 0))) == malformed);
}

TEST_CASE("a lease's features must be sorted, unique and non-zero, and absent under everything") {
    // Product "cs2" ends at 144: everything at 144, the count at 145, features from 147.
    const std::vector<std::byte> lease = encode_lease(fixtures::first_lease());
    const std::vector<std::byte> everything = encode_lease(fixtures::everything_lease());

    CHECK(
        error_of(decode_lease(with_bytes(lease, 147, little_u64(0x9000'0000'0000'0000))))
        == malformed
    );
    CHECK(
        error_of(decode_lease(with_bytes(lease, 155, little_u64(0x0123'4567'89ab'cdef))))
        == malformed
    );
    CHECK(error_of(decode_lease(with_bytes(lease, 147, little_u64(0)))) == malformed);
    CHECK(error_of(decode_lease(with_byte(lease, 144, 1))) == malformed);
    CHECK(error_of(decode_lease(with_byte(everything, 144, 2))) == malformed);
    CHECK(error_of(decode_lease(everything)) == std::nullopt);
}

TEST_CASE("a start request with an unknown channel or unsorted modules is malformed") {
    const std::vector<std::byte> request = encode_start_request(fixtures::request());
    // The modules start at 54, 16 bytes each: the first written over the second repeats it.
    const std::vector<std::byte> first_module{request.begin() + 54, request.begin() + 70};

    CHECK(error_of(decode_start_request(with_byte(request, 32, 3))) == malformed);
    CHECK(error_of(decode_start_request(with_bytes(request, 70, first_module))) == malformed);
    CHECK(error_of(decode_start_request(with_byte(request, 53, 65))) == malformed);
}

TEST_CASE("a start reply with an empty release seal is malformed") {
    const start_reply reply = fixtures::start_reply_of();
    std::vector<std::byte> bytes = encode_start_reply(reply);
    bytes.resize(84);
    bytes.at(80) = std::byte{0};

    CHECK(error_of(decode_start_reply(bytes)) == malformed);
}

TEST_CASE("an enrollment status carries a device after approved and nowhere else") {
    const std::vector<std::byte> approved = encode_enrollment_status(
        enrollment_status{
            .enrollment = fixtures::enrollment,
            .state = enrollment_state::approved,
            .device = fixtures::device,
        }
    );

    CHECK(error_of(decode_enrollment_status(with_byte(approved, 48, 0))) == malformed);
    CHECK(error_of(decode_enrollment_status(with_byte(approved, 48, 4))) == malformed);
    CHECK(error_of(decode_enrollment_request(encode_enrollment_request({}))) == std::nullopt);
}

TEST_CASE("a refusal's code is never 0 and its retry-after flag is 0 or 1") {
    const std::vector<std::byte> refused = encode_refusal(
        refusal{
            .code = refusal_code::rate_limited,
            .retry_after = std::chrono::milliseconds{1000},
        }
    );

    CHECK(error_of(decode_refusal(with_byte(refused, 32, 0))) == malformed);
    CHECK(error_of(decode_refusal(with_byte(refused, 32, 24))) == std::nullopt);
    CHECK(error_of(decode_refusal(with_byte(refused, 33, 2))) == malformed);
}

TEST_CASE("module and server derive the same two session keys, and the two differ") {
    const crypto::exchange_key module = crypto::exchange_key::from_seed(fixtures::module_seed);
    const crypto::exchange_key server = crypto::exchange_key::from_seed(fixtures::server_seed);
    const result<crypto::secret_key> module_shared = module.shared_secret(server.public_part());
    const result<crypto::secret_key> server_shared = server.shared_secret(module.public_part());
    REQUIRE(module_shared.has_value());
    REQUIRE(server_shared.has_value());

    const session_keys module_side = derive_session_keys(
        *module_shared,
        exchange_halves{.module_key = module.public_part(), .server_key = server.public_part()}
    );
    const session_keys server_side = derive_session_keys(
        *server_shared,
        exchange_halves{.module_key = module.public_part(), .server_key = server.public_part()}
    );

    CHECK(
        std::ranges::equal(
            module_side.module_to_server.as_bytes(), server_side.module_to_server.as_bytes()
        )
    );
    CHECK(
        std::ranges::equal(
            module_side.server_to_module.as_bytes(), server_side.server_to_module.as_bytes()
        )
    );
    CHECK_FALSE(
        std::ranges::equal(
            module_side.module_to_server.as_bytes(), module_side.server_to_module.as_bytes()
        )
    );
}

TEST_CASE("a frame opens only under its direction's key and with its header unchanged") {
    const session_keys keys = fixtures::keys();
    const frame sealed = fixtures::renewal_frame();
    frame replayed_later = sealed;
    replayed_later.header.sequence = 1;
    frame reflected = sealed;
    reflected.header.way = direction::server_to_module;
    frame other_session = sealed;
    other_session.header.session.bytes.front() = std::byte{0x12};

    const result<crypto::secret_bytes> opened = open_frame(keys.module_to_server, sealed);

    REQUIRE(opened.has_value());
    CHECK(std::ranges::equal(opened->as_bytes(), encode_lease_renewal(fixtures::renewal())));
    CHECK_FALSE(open_frame(keys.server_to_module, sealed).has_value());
    CHECK_FALSE(open_frame(keys.module_to_server, replayed_later).has_value());
    CHECK_FALSE(open_frame(keys.module_to_server, reflected).has_value());
    CHECK_FALSE(open_frame(keys.module_to_server, other_session).has_value());
}

TEST_CASE("a lease or exchange verifies only under the lease key and only as signed") {
    const crypto::public_key lease_key =
        crypto::signing_key::from_seed(fixtures::lease_seed).public_part();
    const crypto::public_key other_key =
        crypto::signing_key::from_seed(fixtures::other_seed).public_part();
    lease extended = fixtures::first_lease();
    extended.duration = std::chrono::milliseconds{3'600'000};
    session_exchange swapped = fixtures::exchange();
    swapped.server_key = swapped.module_key;

    CHECK(verify_lease(fixtures::first_lease(), lease_key).has_value());
    CHECK_FALSE(verify_lease(fixtures::first_lease(), other_key).has_value());
    CHECK_FALSE(verify_lease(extended, lease_key).has_value());
    CHECK(verify_session_exchange(fixtures::exchange(), lease_key).has_value());
    CHECK_FALSE(verify_session_exchange(fixtures::exchange(), other_key).has_value());
    CHECK_FALSE(verify_session_exchange(swapped, lease_key).has_value());
}

TEST_CASE("a refusal with a code this build doesn't know decodes, keeping the code's number") {
    const std::vector<std::byte> refused =
        encode_refusal(refusal{.code = refusal_code::rate_limited, .retry_after = std::nullopt});

    const result<refusal> decoded = decode_refusal(with_byte(refused, 32, 200));

    REQUIRE(decoded.has_value());
    CHECK(std::to_underlying(decoded->code) == 200);
    CHECK_FALSE(is_known(decoded->code));
    CHECK(name_of(decoded->code) == std::nullopt);
    CHECK(encode_refusal(*decoded) == with_byte(refused, 32, 200));
}

TEST_CASE("a lease request's answer flag is 0 or 1, and its frame runs from module to server") {
    const std::vector<std::byte> request = encode_lease_request(fixtures::lease_request_of());
    const lease_request unanswered{
        .loader_answer = std::nullopt,
        .renewal = fixtures::renewal_frame(),
    };
    // The flag at 32, the answer at 33, the frame's direction 48 bytes into the frame at 65.
    const std::vector<std::byte> answered_none = encode_lease_request(unanswered);

    CHECK(decode_lease_request(request) == fixtures::lease_request_of());
    CHECK(decode_lease_request(answered_none) == unanswered);
    CHECK(error_of(decode_lease_request(with_byte(request, 32, 2))) == malformed);
    CHECK(error_of(decode_lease_request(with_byte(request, 65 + 48, 2))) == malformed);
    CHECK(error_of(decode_lease_request(std::span{request}.first(64))) == malformed);
}

TEST_CASE("a lease response's challenge is not empty, and its frame runs from server to module") {
    const std::vector<std::byte> response = encode_lease_response(fixtures::lease_response_of());
    const std::array<std::byte, 4> zero{};

    // The challenge's size at 52, the frame's direction 48 bytes into the frame at 56.
    CHECK(decode_lease_response(response) == fixtures::lease_response_of());
    CHECK(error_of(decode_lease_response(with_bytes(response, 52, zero))) == malformed);
    CHECK(error_of(decode_lease_response(with_byte(response, 56 + 48, 1))) == malformed);
}

TEST_CASE("the lease response's frame opens to the renewed lease, signed by the lease key") {
    const lease_response response = fixtures::lease_response_of();
    const crypto::public_key lease_key =
        crypto::signing_key::from_seed(fixtures::lease_seed).public_part();

    const result<crypto::secret_bytes> plain =
        open_frame(fixtures::keys().server_to_module, response.lease);
    REQUIRE(plain.has_value());
    const result<lease> granted = decode_lease(plain->as_bytes());

    REQUIRE(granted.has_value());
    CHECK(*granted == fixtures::second_lease());
    CHECK(verify_lease(*granted, lease_key).has_value());
}

}
}
