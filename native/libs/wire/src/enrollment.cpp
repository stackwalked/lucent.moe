#include <lucent/wire/enrollment.hpp>

#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   request: context "lucent enrollment request v1" (32), u8 key storage.
//   status: context "lucent enrollment status v1" (32), enrollment id (16), u8 state, and the
//     device id (16) after approved only.

namespace lucent::wire {
namespace {

constexpr u32 request_version = 1;
constexpr u32 status_version = 1;

auto is_known(key_storage storage) -> bool {
    switch (storage) {
    case key_storage::tpm:
    case key_storage::software:
        return true;
    }
    return false;
}

auto is_known(enrollment_state state) -> bool {
    switch (state) {
    case enrollment_state::pending:
    case enrollment_state::approved:
    case enrollment_state::denied:
    case enrollment_state::expired:
        return true;
    }
    return false;
}

}

auto encode_enrollment_request(const enrollment_request& request) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_known(request.storage));
    detail::writer out;
    out.write_context("enrollment request", request_version);
    out.write_u8(std::to_underlying(request.storage));
    return out.take();
}

auto decode_enrollment_request(std::span<const std::byte> bytes) -> result<enrollment_request> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("enrollment request", request_version));
    const enrollment_request request{
        .storage = static_cast<key_storage>(LUCENT_TRY(input.read_u8())),
    };
    if (!is_known(request.storage)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, request);
}

auto encode_enrollment_status(const enrollment_status& status) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_known(status.state));
    LUCENT_INVARIANT(status.device.has_value() == (status.state == enrollment_state::approved));
    detail::writer out;
    out.write_context("enrollment status", status_version);
    out.write_bytes(status.enrollment.bytes);
    out.write_u8(std::to_underlying(status.state));
    if (status.device) {
        out.write_bytes(status.device->bytes);
    }
    return out.take();
}

auto decode_enrollment_status(std::span<const std::byte> bytes) -> result<enrollment_status> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("enrollment status", status_version));
    enrollment_status status;
    status.enrollment.bytes = LUCENT_TRY(input.read_array<id_size>());
    status.state = static_cast<enrollment_state>(LUCENT_TRY(input.read_u8()));
    if (!is_known(status.state)) {
        return std::unexpected(detail::malformed);
    }
    if (status.state == enrollment_state::approved) {
        status.device = device_id{.bytes = LUCENT_TRY(input.read_array<id_size>())};
    }
    return detail::finish(input, status);
}

}
