#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

// The release manifest (contracts/release-manifest/v1 to v3): which facts a release's module links
// and which capabilities it groups them into, derived from the built module file. Releases are
// built with version 3. The server uses it
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

// Version 2 (contracts/release-manifest/v2) names the product (products/<id>.toml) where version 1
// named the Steam app, and lists the module's features: what the server needs to turn an
// entitlement's feature tags into this release's keyed feature ids. Version 1 stays readable
// through the functions above.

inline constexpr usize max_product_size = 32;
inline constexpr usize max_feature_tag_size = 64;

// A wired feature: its keyed id and the tag an entitlement grants it by (the platform's
// FeatureTag, [a-z0-9][a-z0-9._-]{0,63}).
struct manifest_feature {
    u64 key = 0;
    std::string tag;

    auto operator==(const manifest_feature&) const -> bool = default;
};

struct release_manifest_v2 {
    // [a-z0-9-], 1 to 32 bytes.
    std::string product;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_entry> facts;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_capability> capabilities;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_feature> features;

    auto operator==(const release_manifest_v2&) const -> bool = default;
};

// The manifest must be canonical, as described on its members; anything else is our own bug.
auto encode_release_manifest_v2(const release_manifest_v2& manifest) -> std::vector<std::byte>;

// Canonical or nothing, as decode_release_manifest, and besides: a valid product id, features
// sorted with unique non-zero keys and valid tags. Version 1 bytes are version_mismatch.
auto decode_release_manifest_v2(std::span<const std::byte> bytes) -> result<release_manifest_v2>;

auto manifest_digest(const release_manifest_v2& manifest) -> crypto::digest;
auto core_fact_keys(const release_manifest_v2& manifest) -> std::vector<u64>;

// Version 3 (contracts/release-manifest/v3) is version 2 with, for each fact, the game module it
// resolves in: fact sets are per module build, so the server needs to know which of a release's
// core facts a given module's set must carry, and that a core capability living in a module that
// loads later waits for that module rather than refusing the start. Versions 1 and 2 stay readable
// through the functions above.

// One fact and the game module it resolves in.
struct manifest_fact {
    u64 key = 0;
    u8 kind = 0;
    // The module's name hash (kit::module_name_hash), as fact sets' module keys carry it; never 0.
    u64 module = 0;

    auto operator==(const manifest_fact&) const -> bool = default;
};

struct release_manifest_v3 {
    // [a-z0-9-], 1 to 32 bytes.
    std::string product;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_fact> facts;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_capability> capabilities;
    // Sorted by key, keys unique and never 0.
    std::vector<manifest_feature> features;

    auto operator==(const release_manifest_v3&) const -> bool = default;
};

// The manifest must be canonical, as described on its members; anything else is our own bug.
auto encode_release_manifest_v3(const release_manifest_v3& manifest) -> std::vector<std::byte>;

// Canonical or nothing, as decode_release_manifest_v2, and besides: no fact's module hash is 0.
// Version 1 and 2 bytes are version_mismatch.
auto decode_release_manifest_v3(std::span<const std::byte> bytes) -> result<release_manifest_v3>;

// Over each fact's key and kind only, as the earlier versions: the module computes the same digest
// from its linked facts, which know their module only by the target's index.
auto manifest_digest(const release_manifest_v3& manifest) -> crypto::digest;
auto core_fact_keys(const release_manifest_v3& manifest) -> std::vector<u64>;

// Sorted and unique: the module name hashes the manifest's facts resolve in.
auto fact_modules(const release_manifest_v3& manifest) -> std::vector<u64>;

// Sorted and unique: every fact some core capability needs that resolves in the module named by
// its name hash. Empty for a module no fact resolves in.
auto core_fact_keys(const release_manifest_v3& manifest, u64 module) -> std::vector<u64>;

}
