#pragma once

#include <span>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

// The RFC 6962 tree shape (split at the largest power of two below the size), built bottom-up:
// each level pairs its nodes left to right and carries an odd last node up unchanged, which is
// the same tree. Leaves hash as H(0x00 ‖ leaf), interior nodes as H(0x01 ‖ left ‖ right), so no
// interior hash can pass for a leaf.

namespace lucent::bundle::detail {

auto leaf_hash(const entry& stored) -> crypto::digest;

// H() over nothing for an empty tree.
auto tree_root(std::span<const crypto::digest> leaves) -> crypto::digest;

// The sibling hashes a verifier holding only `present` (sorted leaf indices) asks for, level by
// level from the leaves up, left to right within a level. With nothing present, the proof is
// the root itself.
auto proof_for(std::span<const crypto::digest> leaves, std::span<const u32> present)
    -> std::vector<crypto::digest>;

struct known_leaf {
    u32 index = 0;
    crypto::digest hash{};
};

// The root a proof and the known leaves (sorted, indices below `leaf_count`) lead to. Malformed
// when the proof has too few hashes or any left over.
auto root_from(
    u32 leaf_count, std::span<const known_leaf> known, std::span<const crypto::digest> proof
) -> result<crypto::digest>;

}
