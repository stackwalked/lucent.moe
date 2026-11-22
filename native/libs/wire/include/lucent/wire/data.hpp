#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/wire/ids.hpp>

// The data route (POST /v1/sessions/:id/data): what the module asks the server for and what it
// gets, each the plaintext of a frame under the data route's keys. The session reply carries the
// first response, so a module has its bundle before it attaches.

namespace lucent::wire {

// What the module asks for. Phase 1's server ignores both lists and answers with every entry the
// session is entitled to; they are on the wire so asking for less needs no new version.
struct data_request {
    // The module builds it asks for; sorted and unique.
    std::vector<bundle::module_key> modules;
    // The feature ids it asks for (sorted, unique, never 0), or none for every entry the session is
    // entitled to.
    std::optional<std::vector<u64>> features;

    auto operator==(const data_request&) const -> bool = default;
};

struct data_response {
    // The lease's data revision at the time this was built.
    u64 data_revision = 0;
    // bundle::encode_bundle's bytes, opaque here: the module decodes and verifies the bundle
    // itself. It may hold no sets.
    std::vector<std::byte> bundle_bytes;
    // The asked builds that have no fact set ("not yet supported"); sorted and unique.
    std::vector<bundle::module_key> unsupported;

    auto operator==(const data_response&) const -> bool = default;
};

auto encode_data_request(const data_request& request) -> std::vector<std::byte>;

// Canonical or nothing: modules and features sorted and unique within their bounds, a feature flag
// of 0 or 1, no feature id 0, nothing trailing.
auto decode_data_request(std::span<const std::byte> bytes) -> result<data_request>;

auto encode_data_response(const data_response& response) -> std::vector<std::byte>;

// Canonical or nothing: a bundle that fits in a frame's plaintext, unsupported builds sorted and
// unique, nothing trailing.
auto decode_data_response(std::span<const std::byte> bytes) -> result<data_response>;

}
