#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

namespace lucent::bundle {

// An entry as delivered, with its position in the complete set's sorted order.
struct delivered_entry {
    u32 index = 0;
    entry value;
};

// A fact set as a bundle carries it: the signed header, the entries given to this session, and
// the hashes that let them be checked against the signed root without the rest.
struct delivered_set {
    fact_set_header header;
    // Sorted by index, which is also key order.
    std::vector<delivered_entry> entries;
    std::vector<crypto::digest> proof;
};

// Only the entries with these keys, and the proof for them. Keys the set doesn't hold are ignored.
auto deliver(const fact_set& full, std::span<const u64> keys) -> delivered_set;

// Every entry; the proof is empty.
auto deliver_all(const fact_set& full) -> delivered_set;

auto encode_bundle(std::span<const delivered_set> sets) -> std::vector<std::byte>;

// Canonical or nothing: exact lengths, sorted and unique keys and indices, known payload kinds, no
// trailing bytes. A format this build doesn't read is version_mismatch; anything else malformed.
auto decode_bundle(std::span<const std::byte> bytes) -> result<std::vector<delivered_set>>;

// Signed by one of `trusted`, and every delivered entry provably under the signed root. Says
// nothing about whether the set fits the loaded modules or the linked manifest; resolve checks
// those.
auto verify(const delivered_set& set, std::span<const crypto::public_key> trusted) -> result<void>;

}
