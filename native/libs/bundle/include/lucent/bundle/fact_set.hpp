#pragma once

#include <array>
#include <compare>
#include <cstddef>
#include <optional>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>

namespace lucent::bundle {

// One game module build a fact set is keyed by. The name is hashed so no module name ships.
struct module_key {
    u64 name_hash = 0;
    u32 time_date_stamp = 0;
    u32 size_of_image = 0;

    auto operator<=>(const module_key&) const = default;
};

enum class payload_tag : u8 {
    // An 8-byte value, used as is.
    literal = 0,
};

// One fact's payload; a Merkle leaf.
struct entry {
    u64 key = 0;
    payload_tag tag = payload_tag::literal;
    std::vector<std::byte> payload;

    auto operator==(const entry&) const -> bool = default;
};

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters): a fact key and its value are both u64 by the format.
auto literal(u64 key, u64 value) -> entry;

// The value of a literal entry; nothing for any other kind of payload.
auto literal_value(const entry& stored) -> std::optional<u64>;

using commit_id = std::array<std::byte, 20>;

// Everything the signature covers, then the signature.
struct fact_set_header {
    u32 game = 0;
    u32 revision = 0;
    // Sorted and unique: every module build that shaped the values.
    std::vector<module_key> modules;
    commit_id finders_commit{};
    crypto::digest manifest_digest{};
    u32 entry_count = 0;
    crypto::digest merkle_root{};
    crypto::signature signature{};
};

// A complete, signed fact set: what the generator writes and the server stores.
struct fact_set {
    fact_set_header header;
    // Sorted by key, keys unique.
    std::vector<entry> entries;
};

// One fact as the manifest lists it.
struct manifest_entry {
    u64 key = 0;
    u8 kind = 0;

    auto operator==(const manifest_entry&) const -> bool = default;
};

// BLAKE2b-256 over each entry's key and kind, sorted by key. The module computes it from its own
// linked facts, the generator from the dev build's, and a set only applies where they match.
auto manifest_digest(std::span<const manifest_entry> entries) -> crypto::digest;

// Sorts the entries, fills in their count and Merkle root, and signs the header.
auto sign_fact_set(
    fact_set_header header, std::vector<entry> entries, const crypto::signing_key& signer
) -> fact_set;

// The bytes the signature covers: the header up to, not including, the signature.
auto signed_bytes(const fact_set_header& header) -> std::vector<std::byte>;

}
