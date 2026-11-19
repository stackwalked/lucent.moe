#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

// The release manifest (contracts/release-manifest/v1): which facts a release's module links and
// which capabilities it groups them into, derived from the built module file. The server uses it
// to refuse a session that leaves a core capability uncovered and a fact set that lacks a fact a
// core capability needs.
//
// It is unsigned. It only steers the server's own refusal policy, and a compromised server can
// already refuse or withhold whatever it likes; fact values stay trusted only through the offline
// key that signs fact sets, which this document never vouches for.

namespace lucent::bundle {

enum class capability_level : u8 {
    optional = 0,
    core = 1,
};

struct manifest_capability {
    u64 key = 0;
    capability_level level = capability_level::optional;
    // Sorted and unique, each one among the manifest's facts.
    std::vector<u64> members;

    auto operator==(const manifest_capability&) const -> bool = default;
};

struct release_manifest {
    u32 game = 0;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_entry> facts;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_capability> capabilities;

    auto operator==(const release_manifest&) const -> bool = default;
};

// The manifest must be canonical, as described on its members; anything else is our own bug.
auto encode_release_manifest(const release_manifest& manifest) -> std::vector<std::byte>;

// Canonical or nothing: sorted and unique keys, every member among the facts, known levels, at
// least one member per capability, no trailing bytes. A version this build doesn't read is
// version_mismatch; anything else malformed.
auto decode_release_manifest(std::span<const std::byte> bytes) -> result<release_manifest>;

// The manifest digest of its facts: what the release's fact sets carry. Stored nowhere, so it
// can't disagree with the facts.
auto manifest_digest(const release_manifest& manifest) -> crypto::digest;

// Sorted and unique: every fact some core capability needs.
auto core_fact_keys(const release_manifest& manifest) -> std::vector<u64>;

}
