#include <lucent/wire/start.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <functional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1 on the wire:
//   request: context "lucent start request v1" (32), u8 channel, loader release id (16),
//     u8 product size, product, u8 module count, then per module: u64 name hash,
//     u32 time-date stamp, u32 size of image (as fact sets carry them).
//   reply: context "lucent start reply v1" (32), start id (16), container key (32),
//     u32 release seal size, release seal.

namespace lucent::wire {
namespace {

constexpr u32 request_version = 1;
constexpr u32 reply_version = 1;

constexpr usize module_key_size = 16;

auto is_known(channel chosen) -> bool {
    switch (chosen) {
    case channel::stable:
    case channel::alpha:
    case channel::debug:
        return true;
    }
    return false;
}

auto is_canonical(const start_request& request) -> bool {
    return is_known(request.chosen)
           && request.modules.size() <= max_start_modules
           && std::ranges::adjacent_find(request.modules, std::ranges::greater_equal{})
                  == request.modules.end();
}

auto is_canonical(const start_reply& reply) -> bool {
    return !reply.release_seal.empty() && reply.release_seal.size() <= max_release_seal_size;
}

}

auto encode_start_request(const start_request& request) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(request));
    detail::writer out;
    out.write_context("start request", request_version);
    out.write_u8(std::to_underlying(request.chosen));
    out.write_bytes(request.loader_release.bytes);
    out.write_product(request.product);
    out.write_u8(static_cast<u8>(request.modules.size()));
    for (const bundle::module_key& module : request.modules) {
        out.write_u64(module.name_hash);
        out.write_u32(module.time_date_stamp);
        out.write_u32(module.size_of_image);
    }
    return out.take();
}

auto decode_start_request(std::span<const std::byte> bytes) -> result<start_request> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("start request", request_version));
    start_request request;
    request.chosen = static_cast<channel>(LUCENT_TRY(input.read_u8()));
    request.loader_release.bytes = LUCENT_TRY(input.read_array<id_size>());
    request.product = LUCENT_TRY(input.read_product());
    const u8 count = LUCENT_TRY(input.read_u8());
    if (count > max_start_modules || usize{count} * module_key_size > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    request.modules.reserve(count);
    for (u8 index = 0; index < count; ++index) {
        bundle::module_key module;
        module.name_hash = LUCENT_TRY(input.read_u64());
        module.time_date_stamp = LUCENT_TRY(input.read_u32());
        module.size_of_image = LUCENT_TRY(input.read_u32());
        request.modules.push_back(module);
    }
    if (!is_canonical(request)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(request));
}

auto encode_start_reply(const start_reply& reply) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(reply));
    detail::writer out;
    out.write_context("start reply", reply_version);
    out.write_bytes(reply.start.bytes);
    out.write_bytes(reply.container_key.as_bytes());
    out.write_u32(static_cast<u32>(reply.release_seal.size()));
    out.write_bytes(reply.release_seal);
    return out.take();
}

auto decode_start_reply(std::span<const std::byte> bytes) -> result<start_reply> {
    detail::reader input{bytes};
    LUCENT_TRY(input.read_context("start reply", reply_version));
    const start_id start{.bytes = LUCENT_TRY(input.read_array<id_size>())};
    const std::span<const std::byte> key = LUCENT_TRY(input.read_bytes(container_key_size));
    const u32 size = LUCENT_TRY(input.read_u32());
    if (size > max_release_seal_size) {
        return std::unexpected(detail::malformed);
    }
    const std::span<const std::byte> seal = LUCENT_TRY(input.read_bytes(size));
    start_reply reply{
        .start = start,
        .container_key = crypto::secret_key::from_bytes(key.first<container_key_size>()),
        .release_seal = {seal.begin(), seal.end()},
    };
    if (!is_canonical(reply)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(reply));
}

}
