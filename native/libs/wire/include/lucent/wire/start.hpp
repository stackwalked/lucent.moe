#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

// POST /v1/starts: the loader asks to start a product; every start check runs in one transaction.
// The start expires unused after 60 s; the module's session hello consumes it.

namespace lucent::wire {

inline constexpr usize max_start_modules = 64;
inline constexpr usize container_key_size = 32;
inline constexpr usize max_release_seal_size = usize{1} << 20U;

struct start_request {
    // A product id, as ids.hpp describes it.
    std::string product;
    channel chosen = channel::stable;
    release_id loader_release;
    // The game's module builds, keyed as fact sets key them; sorted and unique.
    std::vector<bundle::module_key> modules;

    auto operator==(const start_request&) const -> bool = default;
};

struct start_reply {
    start_id start;
    // Opens the module container for this start only; wiped with the reply.
    crypto::secret_key container_key;
    // The release seal: the release's offline-signed list of its artifacts and their digests,
    // verified by the loader, opaque here.
    std::vector<std::byte> release_seal;
};

auto encode_start_request(const start_request& request) -> std::vector<std::byte>;

// Canonical or nothing: a valid product id, a known channel, modules sorted and unique.
auto decode_start_request(std::span<const std::byte> bytes) -> result<start_request>;

auto encode_start_reply(const start_reply& reply) -> std::vector<std::byte>;

// Canonical or nothing: a release seal of 1 byte to 1 MiB, nothing trailing.
auto decode_start_reply(std::span<const std::byte> bytes) -> result<start_reply>;

}
