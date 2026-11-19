#include <lucent/wire/lease.hpp>

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <expected>
#include <functional>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/frame.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/session.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   lease: context "lucent lease v1" (32), session id (16), device id (16), release id (16),
//     u64 sequence, module nonce (16), u32 duration in milliseconds, u64 bundle revision,
//     challenge nonce (16), u32 challenge offset, u32 challenge size, u8 product size, product,
//     u8 everything (0 or 1), u16 feature count, u64 feature ids, Ed25519 signature (64) over
//     everything before it.
//   renewal: context "lucent lease renewal v1" (32), u64 sequence, module nonce (16),
//     challenge answer (32), signals (64).
//   request: context "lucent lease request v1" (32), u8 has loader answer (0 or 1), loader
//     answer (32) after 1 only, then a frame (module to server) running to the end.
//   response: context "lucent lease response v1" (32), loader challenge nonce (16), u32 offset,
//     u32 size, then a frame (server to module) running to the end.

namespace lucent::wire {
namespace {

constexpr u32 lease_version = 1;
constexpr u32 renewal_version = 1;
constexpr u32 request_version = 1;
constexpr u32 response_version = 1;

auto is_canonical(const entitled_features& entitled) -> bool {
    if (entitled.is_everything) {
        return entitled.features.empty();
    }
    return entitled.features.size() <= max_features
           && !std::ranges::contains(entitled.features, u64{0})
           && std::ranges::adjacent_find(entitled.features, std::ranges::greater_equal{})
                  == entitled.features.end();
}

auto is_canonical(const lease& granted) -> bool {
    return granted.duration.count() > 0
           && std::cmp_less_equal(granted.duration.count(), u32{0xffff'ffff})
           && granted.challenge.size > 0
           && is_canonical(granted.entitled);
}

auto write_lease_fields(detail::writer& out, const lease& granted) -> void {
    LUCENT_INVARIANT(is_canonical(granted));
    out.write_context("lease", lease_version);
    out.write_bytes(granted.session.bytes);
    out.write_bytes(granted.device.bytes);
    out.write_bytes(granted.release.bytes);
    out.write_u64(granted.sequence);
    out.write_bytes(granted.nonce);
    out.write_u32(static_cast<u32>(granted.duration.count()));
    out.write_u64(granted.bundle_revision);
    out.write_bytes(granted.challenge.nonce);
    out.write_u32(granted.challenge.offset);
    out.write_u32(granted.challenge.size);
    out.write_product(granted.product);
    out.write_u8(granted.entitled.is_everything ? 1 : 0);
    out.write_u16(static_cast<u16>(granted.entitled.features.size()));
    for (const u64 feature : granted.entitled.features) {
        out.write_u64(feature);
    }
}

// Everything before the challenge.
auto read_lease_head(detail::reader& input) -> result<lease> {
    lease granted;
    granted.session.bytes = LUCENT_TRY(input.read_array<id_size>());
    granted.device.bytes = LUCENT_TRY(input.read_array<id_size>());
    granted.release.bytes = LUCENT_TRY(input.read_array<id_size>());
    granted.sequence = LUCENT_TRY(input.read_u64());
    granted.nonce = LUCENT_TRY(input.read_array<module_nonce_size>());
    granted.duration = std::chrono::milliseconds{LUCENT_TRY(input.read_u32())};
    granted.bundle_revision = LUCENT_TRY(input.read_u64());
    return granted;
}

auto read_challenge(detail::reader& input) -> result<hash_challenge> {
    hash_challenge challenge;
    challenge.nonce = LUCENT_TRY(input.read_array<challenge_nonce_size>());
    challenge.offset = LUCENT_TRY(input.read_u32());
    challenge.size = LUCENT_TRY(input.read_u32());
    return challenge;
}

auto read_features(detail::reader& input) -> result<entitled_features> {
    entitled_features entitled;
    entitled.is_everything = LUCENT_TRY(input.read_bool());
    const u16 count = LUCENT_TRY(input.read_u16());
    if (count > max_features || usize{count} * 8 > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    entitled.features.reserve(count);
    for (u16 index = 0; index < count; ++index) {
        entitled.features.push_back(LUCENT_TRY(input.read_u64()));
    }
    return entitled;
}

}

auto signed_bytes(const lease& granted) -> std::vector<std::byte> {
    detail::writer out;
    write_lease_fields(out, granted);
    return out.take();
}

auto sign_lease(lease granted, const crypto::signing_key& lease_key) -> lease {
    granted.signature = lease_key.sign(signed_bytes(granted));
    return granted;
}

auto verify_lease(const lease& granted, const crypto::public_key& lease_key) -> result<void> {
    return crypto::verify(lease_key, signed_bytes(granted), granted.signature);
}

auto encode_lease(const lease& granted) -> std::vector<std::byte> {
    detail::writer out;
    write_lease_fields(out, granted);
    out.write_bytes(granted.signature);
    return out.take();
}

auto decode_lease(std::span<const std::byte> bytes) -> result<lease> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("lease", lease_version));
    lease granted = LUCENT_TRY(read_lease_head(input));
    granted.challenge = LUCENT_TRY(read_challenge(input));
    granted.product = LUCENT_TRY(input.read_product());
    granted.entitled = LUCENT_TRY(read_features(input));
    granted.signature = LUCENT_TRY(input.read_array<crypto::signature_size>());
    if (!is_canonical(granted)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(granted));
}

auto encode_lease_renewal(const lease_renewal& renewal) -> std::vector<std::byte> {
    detail::writer out;
    out.write_context("lease renewal", renewal_version);
    out.write_u64(renewal.sequence);
    out.write_bytes(renewal.nonce);
    out.write_bytes(renewal.challenge_answer);
    out.write_bytes(renewal.signals);
    return out.take();
}

auto decode_lease_renewal(std::span<const std::byte> bytes) -> result<lease_renewal> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("lease renewal", renewal_version));
    lease_renewal renewal;
    renewal.sequence = LUCENT_TRY(input.read_u64());
    renewal.nonce = LUCENT_TRY(input.read_array<module_nonce_size>());
    renewal.challenge_answer = LUCENT_TRY(input.read_array<crypto::digest_size>());
    renewal.signals = LUCENT_TRY(input.read_array<signals_size>());
    return detail::finish(input, renewal);
}

auto encode_lease_request(const lease_request& request) -> std::vector<std::byte> {
    LUCENT_INVARIANT(request.renewal.header.way == direction::module_to_server);
    detail::writer out;
    out.write_context("lease request", request_version);
    out.write_u8(request.loader_answer ? 1 : 0);
    if (request.loader_answer) {
        out.write_bytes(*request.loader_answer);
    }
    out.write_bytes(encode_frame(request.renewal));
    return out.take();
}

auto decode_lease_request(std::span<const std::byte> bytes) -> result<lease_request> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("lease request", request_version));
    std::optional<crypto::digest> loader_answer;
    if (LUCENT_TRY(input.read_bool())) {
        loader_answer = LUCENT_TRY(input.read_array<crypto::digest_size>());
    }
    const std::span<const std::byte> rest = LUCENT_TRY(input.read_bytes(input.remaining()));
    frame renewal = LUCENT_TRY(decode_frame(rest));
    if (renewal.header.way != direction::module_to_server) {
        return std::unexpected(detail::malformed);
    }
    return lease_request{.loader_answer = loader_answer, .renewal = std::move(renewal)};
}

auto encode_lease_response(const lease_response& response) -> std::vector<std::byte> {
    LUCENT_INVARIANT(response.loader_challenge.size > 0);
    LUCENT_INVARIANT(response.lease.header.way == direction::server_to_module);
    detail::writer out;
    out.write_context("lease response", response_version);
    out.write_bytes(response.loader_challenge.nonce);
    out.write_u32(response.loader_challenge.offset);
    out.write_u32(response.loader_challenge.size);
    out.write_bytes(encode_frame(response.lease));
    return out.take();
}

auto decode_lease_response(std::span<const std::byte> bytes) -> result<lease_response> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("lease response", response_version));
    const hash_challenge loader_challenge = LUCENT_TRY(read_challenge(input));
    const std::span<const std::byte> rest = LUCENT_TRY(input.read_bytes(input.remaining()));
    frame sealed_lease = LUCENT_TRY(decode_frame(rest));
    if (loader_challenge.size == 0 || sealed_lease.header.way != direction::server_to_module) {
        return std::unexpected(detail::malformed);
    }
    return lease_response{.loader_challenge = loader_challenge, .lease = std::move(sealed_lease)};
}

}
