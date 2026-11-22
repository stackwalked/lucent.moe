#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <filesystem>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/data.hpp>
#include <lucent/wire/enrollment.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/lease.hpp>
#include <lucent/wire/refusal.hpp>
#include <lucent/wire/session.hpp>
#include <lucent/wire/start.hpp>

#include "fixtures.hpp"
#include "json.hpp"

// The /v1 messages' golden vectors in contracts/wire/v1: each is a .bin and a .json stating its
// contents, which every implementation (this one, the TS server) must agree on. The session reply
// and renewal frame also state the secrets behind them (seeds, shared secret, the six session
// keys, plaintext), so another implementation can check its key exchange and AEAD against them.
// Rewritten with LUCENT_WRITE_VECTORS=1 (`moon run wire:vectors`); review the diff.

namespace lucent::wire {
namespace {

auto image_kind_name(image_kind kind) -> std::string_view {
    switch (kind) {
    case image_kind::loaded:
        return "loaded";
    case image_kind::mapped:
        return "mapped";
    }
    LUCENT_UNREACHABLE();
}

auto channel_name(channel chosen) -> std::string_view {
    switch (chosen) {
    case channel::stable:
        return "stable";
    case channel::alpha:
        return "alpha";
    case channel::debug:
        return "debug";
    }
    LUCENT_UNREACHABLE();
}

auto storage_name(key_storage storage) -> std::string_view {
    switch (storage) {
    case key_storage::tpm:
        return "tpm";
    case key_storage::software:
        return "software";
    }
    LUCENT_UNREACHABLE();
}

auto state_name(enrollment_state state) -> std::string_view {
    switch (state) {
    case enrollment_state::pending:
        return "pending";
    case enrollment_state::approved:
        return "approved";
    case enrollment_state::denied:
        return "denied";
    case enrollment_state::expired:
        return "expired";
    }
    LUCENT_UNREACHABLE();
}

auto hello_json(const session_hello& hello, usize indent) -> std::string {
    return object(
        {
            field{.name = "module_key", .value = hex_field(hello.module_key)},
            field{.name = "nonce", .value = hex_field(hello.nonce)},
            field{.name = "release", .value = hex_field(hello.release.bytes)},
            field{
                .name = "boot_info_version",
                .value = std::format("{}", hello.boot.boot_info_version),
            },
            field{.name = "image_kind", .value = json_string(image_kind_name(hello.boot.kind))},
            field{.name = "image_base", .value = u64_field(hello.boot.image_base)},
            field{.name = "image_size", .value = std::format("{}", hello.boot.image_size)},
        },
        indent
    );
}

auto exchange_json(const session_exchange& exchange, usize indent) -> std::string {
    return object(
        {
            field{.name = "session", .value = hex_field(exchange.session.bytes)},
            field{.name = "module_key", .value = hex_field(exchange.module_key)},
            field{.name = "nonce", .value = hex_field(exchange.nonce)},
            field{.name = "server_key", .value = hex_field(exchange.server_key)},
            field{.name = "signature", .value = hex_field(exchange.signature)},
        },
        indent
    );
}

auto modules_json(std::span<const bundle::module_key> modules, usize indent) -> std::string {
    std::vector<std::string> items;
    items.reserve(modules.size());
    for (const bundle::module_key& module : modules) {
        items.push_back(object(
            {
                field{.name = "name_hash", .value = u64_field(module.name_hash)},
                field{
                    .name = "time_date_stamp",
                    .value = json_string(std::format("{:08x}", module.time_date_stamp)),
                },
                field{
                    .name = "size_of_image",
                    .value = json_string(std::format("{:08x}", module.size_of_image)),
                },
            },
            indent + 2
        ));
    }
    return array(items, indent);
}

auto lease_json(const lease& granted, usize indent) -> std::string {
    std::vector<std::string> features;
    features.reserve(granted.entitled.features.size());
    for (const u64 feature : granted.entitled.features) {
        features.push_back(u64_field(feature));
    }
    return object(
        {
            field{.name = "session", .value = hex_field(granted.session.bytes)},
            field{.name = "device", .value = hex_field(granted.device.bytes)},
            field{.name = "release", .value = hex_field(granted.release.bytes)},
            field{.name = "sequence", .value = std::format("{}", granted.sequence)},
            field{.name = "nonce", .value = hex_field(granted.nonce)},
            field{.name = "duration_ms", .value = std::format("{}", granted.duration.count())},
            field{.name = "data_revision", .value = std::format("{}", granted.data_revision)},
            field{
                .name = "challenge",
                .value = object(
                    {
                        field{.name = "nonce", .value = hex_field(granted.challenge.nonce)},
                        field{
                            .name = "offset",
                            .value = std::format("{}", granted.challenge.offset),
                        },
                        field{.name = "size", .value = std::format("{}", granted.challenge.size)},
                    },
                    indent + 2
                ),
            },
            field{.name = "product", .value = json_string(granted.product)},
            field{
                .name = "everything",
                .value = granted.entitled.is_everything ? "true" : "false",
            },
            field{.name = "features", .value = array(features, indent + 2)},
            field{.name = "signature", .value = hex_field(granted.signature)},
        },
        indent
    );
}

auto frame_json(const frame& sealed, usize indent) -> std::string {
    return object(
        {
            field{.name = "session", .value = hex_field(sealed.header.session.bytes)},
            field{
                .name = "direction",
                .value = sealed.header.way == direction::module_to_server
                             ? json_string("module_to_server")
                             : json_string("server_to_module"),
            },
            field{.name = "sequence", .value = std::format("{}", sealed.header.sequence)},
            field{.name = "nonce", .value = hex_field(sealed.nonce)},
            field{.name = "sealed", .value = hex_field(sealed.sealed)},
            field{.name = "associated_data", .value = hex_field(associated_data(sealed.header))},
        },
        indent
    );
}

auto secrets_json(usize indent) -> std::string {
    const crypto::exchange_key module = crypto::exchange_key::from_seed(fixtures::module_seed);
    const crypto::exchange_key server = crypto::exchange_key::from_seed(fixtures::server_seed);
    const result<crypto::secret_key> shared = module.shared_secret(server.public_part());
    LUCENT_INVARIANT(shared.has_value());
    const session_keys keys = fixtures::keys();
    return object(
        {
            field{
                .name = "lease_public_key",
                .value =
                    hex_field(crypto::signing_key::from_seed(fixtures::lease_seed).public_part()),
            },
            field{.name = "module_seed", .value = hex_field(fixtures::module_seed)},
            field{.name = "server_seed", .value = hex_field(fixtures::server_seed)},
            field{.name = "shared_secret", .value = hex_field(shared->as_bytes())},
            field{
                .name = "lease_module_to_server_key",
                .value = hex_field(keys.lease.module_to_server.as_bytes()),
            },
            field{
                .name = "lease_server_to_module_key",
                .value = hex_field(keys.lease.server_to_module.as_bytes()),
            },
            field{
                .name = "data_module_to_server_key",
                .value = hex_field(keys.data.module_to_server.as_bytes()),
            },
            field{
                .name = "data_server_to_module_key",
                .value = hex_field(keys.data.server_to_module.as_bytes()),
            },
            field{
                .name = "reports_module_to_server_key",
                .value = hex_field(keys.reports.module_to_server.as_bytes()),
            },
            field{
                .name = "reports_server_to_module_key",
                .value = hex_field(keys.reports.server_to_module.as_bytes()),
            },
        },
        indent
    );
}

auto challenge_json(const hash_challenge& challenge, usize indent) -> std::string {
    return object(
        {
            field{.name = "nonce", .value = hex_field(challenge.nonce)},
            field{.name = "offset", .value = std::format("{}", challenge.offset)},
            field{.name = "size", .value = std::format("{}", challenge.size)},
        },
        indent
    );
}

auto lease_request_json(const lease_request& request) -> std::string {
    return object(
        {
            field{
                .name = "loader_answer",
                .value = request.loader_answer ? hex_field(*request.loader_answer) : "null",
            },
            field{.name = "renewal_frame", .value = frame_json(request.renewal, 2)},
        },
        0
    );
}

auto lease_response_json(const lease_response& response) -> std::string {
    return object(
        {
            field{
                .name = "loader_challenge",
                .value = challenge_json(response.loader_challenge, 2),
            },
            field{.name = "lease_frame", .value = frame_json(response.lease, 2)},
            field{
                .name = "lease_plain",
                .value = hex_field(encode_lease(fixtures::second_lease())),
            },
            field{.name = "lease", .value = lease_json(fixtures::second_lease(), 2)},
        },
        0
    );
}

auto renewal_json(const lease_renewal& renewal, usize indent) -> std::string {
    return object(
        {
            field{.name = "sequence", .value = std::format("{}", renewal.sequence)},
            field{.name = "nonce", .value = hex_field(renewal.nonce)},
            field{.name = "challenge_answer", .value = hex_field(renewal.challenge_answer)},
            field{.name = "signals", .value = hex_field(renewal.signals)},
        },
        indent
    );
}

auto start_request_json(const start_request& request) -> std::string {
    return object(
        {
            field{.name = "product", .value = json_string(request.product)},
            field{.name = "channel", .value = json_string(channel_name(request.chosen))},
            field{.name = "loader_release", .value = hex_field(request.loader_release.bytes)},
            field{.name = "modules", .value = modules_json(request.modules, 2)},
        },
        0
    );
}

auto data_request_json(const data_request& request) -> std::string {
    std::vector<std::string> features;
    for (const u64 feature : request.features.value_or(std::vector<u64>{})) {
        features.push_back(u64_field(feature));
    }
    return object(
        {
            field{.name = "modules", .value = modules_json(request.modules, 2)},
            field{
                .name = "features",
                .value = request.features ? array(features, 2) : "null",
            },
        },
        0
    );
}

auto data_response_json(const data_response& response, usize indent) -> std::string {
    return object(
        {
            field{.name = "data_revision", .value = std::format("{}", response.data_revision)},
            field{.name = "bundle", .value = hex_field(response.bundle_bytes)},
            field{.name = "unsupported", .value = modules_json(response.unsupported, indent + 2)},
        },
        indent
    );
}

auto start_reply_json(const start_reply& reply) -> std::string {
    return object(
        {
            field{.name = "start", .value = hex_field(reply.start.bytes)},
            field{.name = "container_key", .value = hex_field(reply.container_key.as_bytes())},
            field{.name = "release_seal", .value = hex_field(reply.release_seal)},
        },
        0
    );
}

auto status_json(const enrollment_status& status) -> std::string {
    return object(
        {
            field{.name = "enrollment", .value = hex_field(status.enrollment.bytes)},
            field{.name = "state", .value = json_string(state_name(status.state))},
            field{
                .name = "device",
                .value = status.device ? hex_field(status.device->bytes) : "null",
            },
        },
        0
    );
}

auto refusal_json(const refusal& refused) -> std::string {
    return object(
        {
            field{
                .name = "code",
                .value = json_string(name_of(refused.code).value_or("UNKNOWN")),
            },
            field{
                .name = "raw_code",
                .value = std::format("{}", std::to_underlying(refused.code)),
            },
            field{
                .name = "retry_after_ms",
                .value =
                    refused.retry_after ? std::format("{}", refused.retry_after->count()) : "null",
            },
        },
        0
    );
}

// One vector: its bytes from the encoder, its description, and how its bytes decode and
// encode again: canonical bytes come back exactly.
struct vector_case {
    std::string_view name;
    std::vector<std::byte> bytes;
    std::string json;
    auto (*decode_and_encode)(std::span<const std::byte>)
        -> result<std::vector<std::byte>> = nullptr;
};

auto cases() -> std::vector<vector_case> {
    const session_reply reply = fixtures::reply();
    const frame renewal_frame = fixtures::renewal_frame();
    const enrollment_status pending{
        .enrollment = fixtures::enrollment,
        .state = enrollment_state::pending,
        .device = std::nullopt,
    };
    const enrollment_status approved{
        .enrollment = fixtures::enrollment,
        .state = enrollment_state::approved,
        .device = fixtures::device,
    };
    const refusal slot_taken{.code = refusal_code::slot_taken, .retry_after = std::nullopt};
    // A code a later build might add, 200: it decodes, keeping its number.
    std::vector<std::byte> unknown_bytes = encode_refusal(slot_taken);
    unknown_bytes.at(32) = std::byte{200};
    const refusal unknown = decode_refusal(unknown_bytes).value_or(slot_taken);
    const refusal rate_limited{
        .code = refusal_code::rate_limited,
        .retry_after = std::chrono::milliseconds{30'000},
    };
    const enrollment_request request{.storage = key_storage::software};
    return {
        vector_case{
            .name = "session_hello",
            .bytes = encode_session_hello(fixtures::hello()),
            .json = hello_json(fixtures::hello(), 0),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_session_hello(bytes).transform(encode_session_hello);
                },
        },
        vector_case{
            .name = "session_reply",
            .bytes = encode_session_reply(reply),
            .json = object(
                {
                    field{.name = "exchange", .value = exchange_json(reply.exchange, 2)},
                    field{.name = "first_lease_frame", .value = frame_json(reply.first_lease, 2)},
                    field{
                        .name = "first_lease_plain",
                        .value = hex_field(encode_lease(fixtures::first_lease())),
                    },
                    field{.name = "first_lease", .value = lease_json(fixtures::first_lease(), 2)},
                    field{.name = "first_data_frame", .value = frame_json(reply.first_data, 2)},
                    field{
                        .name = "first_data_plain",
                        .value = hex_field(encode_data_response(fixtures::first_data())),
                    },
                    field{
                        .name = "first_data",
                        .value = data_response_json(fixtures::first_data(), 2),
                    },
                    field{.name = "secrets", .value = secrets_json(2)},
                },
                0
            ),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_session_reply(bytes).transform(encode_session_reply);
                },
        },
        vector_case{
            .name = "lease_everything",
            .bytes = encode_lease(fixtures::everything_lease()),
            .json = lease_json(fixtures::everything_lease(), 0),
            .decode_and_encode = [](
                                     std::span<const std::byte> bytes
                                 ) { return decode_lease(bytes).transform(encode_lease); },
        },
        vector_case{
            .name = "renewal_frame",
            .bytes = encode_frame(renewal_frame),
            .json = object(
                {
                    field{.name = "frame", .value = frame_json(renewal_frame, 2)},
                    field{
                        .name = "renewal_plain",
                        .value = hex_field(encode_lease_renewal(fixtures::renewal())),
                    },
                    field{.name = "renewal", .value = renewal_json(fixtures::renewal(), 2)},
                },
                0
            ),
            .decode_and_encode = [](
                                     std::span<const std::byte> bytes
                                 ) { return decode_frame(bytes).transform(encode_frame); },
        },
        vector_case{
            .name = "lease_request",
            .bytes = encode_lease_request(fixtures::lease_request_of()),
            .json = lease_request_json(fixtures::lease_request_of()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_lease_request(bytes).transform(encode_lease_request);
                },
        },
        vector_case{
            .name = "lease_response",
            .bytes = encode_lease_response(fixtures::lease_response_of()),
            .json = lease_response_json(fixtures::lease_response_of()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_lease_response(bytes).transform(encode_lease_response);
                },
        },
        vector_case{
            .name = "start_request",
            .bytes = encode_start_request(fixtures::request()),
            .json = start_request_json(fixtures::request()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_start_request(bytes).transform(encode_start_request);
                },
        },
        vector_case{
            .name = "start_reply",
            .bytes = encode_start_reply(fixtures::start_reply_of()),
            .json = start_reply_json(fixtures::start_reply_of()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_start_reply(bytes).transform(encode_start_reply);
                },
        },
        vector_case{
            .name = "data_request",
            .bytes = encode_data_request(fixtures::data_request_of()),
            .json = data_request_json(fixtures::data_request_of()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_data_request(bytes).transform(encode_data_request);
                },
        },
        vector_case{
            .name = "data_request_everything",
            .bytes = encode_data_request(fixtures::data_request_everything()),
            .json = data_request_json(fixtures::data_request_everything()),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_data_request(bytes).transform(encode_data_request);
                },
        },
        vector_case{
            .name = "data_response",
            .bytes = encode_data_response(fixtures::first_data()),
            .json = data_response_json(fixtures::first_data(), 0),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_data_response(bytes).transform(encode_data_response);
                },
        },
        vector_case{
            .name = "enrollment_request",
            .bytes = encode_enrollment_request(request),
            .json = object(
                {field{.name = "storage", .value = json_string(storage_name(request.storage))}}, 0
            ),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_enrollment_request(bytes).transform(encode_enrollment_request);
                },
        },
        vector_case{
            .name = "enrollment_pending",
            .bytes = encode_enrollment_status(pending),
            .json = status_json(pending),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_enrollment_status(bytes).transform(encode_enrollment_status);
                },
        },
        vector_case{
            .name = "enrollment_approved",
            .bytes = encode_enrollment_status(approved),
            .json = status_json(approved),
            .decode_and_encode =
                [](std::span<const std::byte> bytes) {
                    return decode_enrollment_status(bytes).transform(encode_enrollment_status);
                },
        },
        vector_case{
            .name = "refusal_slot_taken",
            .bytes = encode_refusal(slot_taken),
            .json = refusal_json(slot_taken),
            .decode_and_encode = [](
                                     std::span<const std::byte> bytes
                                 ) { return decode_refusal(bytes).transform(encode_refusal); },
        },
        vector_case{
            .name = "refusal_rate_limited",
            .bytes = encode_refusal(rate_limited),
            .json = refusal_json(rate_limited),
            .decode_and_encode = [](
                                     std::span<const std::byte> bytes
                                 ) { return decode_refusal(bytes).transform(encode_refusal); },
        },
        vector_case{
            .name = "refusal_unknown",
            .bytes = encode_refusal(unknown),
            .json = refusal_json(unknown),
            .decode_and_encode = [](std::span<const std::byte> bytes) {
                return decode_refusal(bytes).transform(encode_refusal);
            },
        },
    };
}

auto directory() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / "wire" / "v1";
}

auto should_write() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_WRITE_VECTORS", value.data(), 2) == 1
           && value.front() == L'1';
}

auto write_vector(const vector_case& vector) -> void {
    const std::string json = vector.json + "\n";
    std::filesystem::create_directories(directory());
    REQUIRE(
        os::write_file(directory() / std::format("{}.bin", vector.name), vector.bytes).has_value()
    );
    REQUIRE(
        os::write_file(
            directory() / std::format("{}.json", vector.name), std::as_bytes(std::span{json})
        )
            .has_value()
    );
}

auto check_vector(const vector_case& vector) -> void {
    INFO(vector.name);
    const result<std::vector<std::byte>> stored_bytes =
        os::read_file(directory() / std::format("{}.bin", vector.name));
    const result<std::vector<std::byte>> stored_json =
        os::read_file(directory() / std::format("{}.json", vector.name));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());
    const std::string json = vector.json + "\n";

    CHECK(*stored_bytes == vector.bytes);
    CHECK(vector.decode_and_encode(*stored_bytes) == vector.bytes);
    CHECK(std::ranges::equal(*stored_json, std::as_bytes(std::span{json})));
}

TEST_CASE("each wire golden vector is its source's encoding, and decodes back to that source") {
    for (const vector_case& vector : cases()) {
        if (should_write()) {
            write_vector(vector);
        }
        check_vector(vector);
    }
}

TEST_CASE("the golden session reply's frames open to its lease and its first data") {
    const result<std::vector<std::byte>> stored = os::read_file(directory() / "session_reply.bin");
    REQUIRE(stored.has_value());
    const result<session_reply> reply = decode_session_reply(*stored);
    REQUIRE(reply.has_value());
    const crypto::public_key lease_key =
        crypto::signing_key::from_seed(fixtures::lease_seed).public_part();

    const result<crypto::secret_bytes> plain =
        open_frame(fixtures::keys().lease.server_to_module, reply->first_lease);
    REQUIRE(plain.has_value());
    const result<lease> granted = decode_lease(plain->as_bytes());

    CHECK(verify_session_exchange(reply->exchange, lease_key).has_value());
    REQUIRE(granted.has_value());
    CHECK(*granted == fixtures::first_lease());
    CHECK(verify_lease(*granted, lease_key).has_value());

    const result<crypto::secret_bytes> data_plain =
        open_frame(fixtures::keys().data.server_to_module, reply->first_data);
    REQUIRE(data_plain.has_value());
    CHECK(decode_data_response(data_plain->as_bytes()) == fixtures::first_data());
    CHECK_FALSE(open_frame(fixtures::keys().lease.server_to_module, reply->first_data).has_value());
}

}
}
