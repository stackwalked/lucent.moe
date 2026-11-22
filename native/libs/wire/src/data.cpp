#include <lucent/wire/data.hpp>

#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/wire/frame.hpp>
#include <lucent/wire/lease.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   request: context "lucent data request v1" (32), u8 module count, then per module: u64 name
//     hash, u32 time-date stamp, u32 size of image (as start requests carry them); u8 has features
//     (0 or 1), after 1 only u32 feature count, u64 feature ids.
//   response: context "lucent data response v1" (32), u64 data revision, u32 bundle size, the
//     bundle, u8 unsupported module count, then the modules as in the request.

namespace lucent::wire {
namespace {

constexpr u32 request_version = 1;
constexpr u32 response_version = 1;

constexpr usize feature_size = 8;

auto is_canonical(const data_request& request) -> bool {
    return detail::is_canonical_modules(request.modules)
           && (!request.features || detail::is_canonical_features(*request.features));
}

auto is_canonical(const data_response& response) -> bool {
    return response.bundle_bytes.size() <= max_frame_plain_size
           && detail::is_canonical_modules(response.unsupported);
}

}

auto encode_data_request(const data_request& request) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(request));
    detail::writer out;
    out.write_context("data request", request_version);
    out.write_modules(request.modules);
    out.write_u8(request.features ? 1 : 0);
    if (request.features) {
        out.write_u32(static_cast<u32>(request.features->size()));
        for (const u64 feature : *request.features) {
            out.write_u64(feature);
        }
    }
    return out.take();
}

auto decode_data_request(std::span<const std::byte> bytes) -> result<data_request> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("data request", request_version));
    data_request request;
    request.modules = LUCENT_TRY(input.read_modules());
    if (LUCENT_TRY(input.read_bool())) {
        const u32 count = LUCENT_TRY(input.read_u32());
        if (count > max_features || usize{count} * feature_size > input.remaining()) {
            return std::unexpected(detail::malformed);
        }
        std::vector<u64> features;
        features.reserve(count);
        for (u32 index = 0; index < count; ++index) {
            features.push_back(LUCENT_TRY(input.read_u64()));
        }
        request.features = std::move(features);
    }
    if (!is_canonical(request)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(request));
}

auto encode_data_response(const data_response& response) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(response));
    detail::writer out;
    out.write_context("data response", response_version);
    out.write_u64(response.data_revision);
    out.write_u32(static_cast<u32>(response.bundle_bytes.size()));
    out.write_bytes(response.bundle_bytes);
    out.write_modules(response.unsupported);
    return out.take();
}

auto decode_data_response(std::span<const std::byte> bytes) -> result<data_response> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("data response", response_version));
    data_response response;
    response.data_revision = LUCENT_TRY(input.read_u64());
    const u32 size = LUCENT_TRY(input.read_u32());
    if (size > max_frame_plain_size) {
        return std::unexpected(detail::malformed);
    }
    const std::span<const std::byte> bundle_bytes = LUCENT_TRY(input.read_bytes(size));
    response.bundle_bytes.assign(bundle_bytes.begin(), bundle_bytes.end());
    response.unsupported = LUCENT_TRY(input.read_modules());
    return detail::finish(input, std::move(response));
}

}
