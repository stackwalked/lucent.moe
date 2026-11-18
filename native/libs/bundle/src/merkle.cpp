#include "merkle.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <iterator>
#include <span>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

#include "wire.hpp"

namespace lucent::bundle::detail {
namespace {

constexpr u8 leaf_prefix = 0x00;
constexpr u8 node_prefix = 0x01;

struct positioned {
    u64 position = 0;
    crypto::digest hash{};
};

// The one indexed read in this file; positions are checked against sizes before every call.
template <typename T>
auto element(std::span<const T> items, u64 position) -> const T& {
    LUCENT_INVARIANT(position < items.size());
    // NOLINTNEXTLINE(cppcoreguidelines-pro-bounds-avoid-unchecked-container-access): checked on the line above.
    return items[position];
}

auto node_hash(const crypto::digest& left, const crypto::digest& right) -> crypto::digest {
    std::array<std::byte, 1 + (2 * crypto::digest_size)> bytes{};
    bytes.front() = static_cast<std::byte>(node_prefix);
    std::ranges::copy(left, bytes.begin() + 1);
    std::ranges::copy(right, bytes.begin() + 1 + crypto::digest_size);
    return crypto::hash(bytes);
}

// A verifier's pass up the tree, taking proof hashes in the order the encoder emitted them.
class proof_walk final {
public:
    explicit proof_walk(std::span<const crypto::digest> proof)
        : m_proof{proof} {}

    // The known nodes one level up, from the known nodes at a level `width` wide.
    auto parents_of(std::span<const positioned> level, u64 width)
        -> result<std::vector<positioned>> {
        std::vector<positioned> parents;
        parents.reserve(level.size());
        for (auto at = level.begin(); at != level.end(); ++at) {
            const u64 sibling = at->position ^ 1U;
            const bool is_sibling_known =
                std::next(at) != level.end() && std::next(at)->position == sibling;
            crypto::digest parent{};
            if (sibling >= width) {
                parent = at->hash;
            } else if (is_sibling_known) {
                parent = node_hash(at->hash, std::next(at)->hash);
                ++at;
            } else {
                const crypto::digest other = LUCENT_TRY(next_hash());
                parent =
                    at->position % 2 == 0 ? node_hash(at->hash, other) : node_hash(other, at->hash);
            }
            parents.push_back(positioned{.position = at->position / 2, .hash = parent});
        }
        return parents;
    }

    auto is_used_up() const -> bool {
        return m_used == m_proof.size();
    }

private:
    auto next_hash() -> result<crypto::digest> {
        if (is_used_up()) {
            return std::unexpected(error{.code = error_code::malformed});
        }
        const crypto::digest hash = element(m_proof, m_used);
        ++m_used;
        return hash;
    }

    std::span<const crypto::digest> m_proof;
    usize m_used = 0;
};

auto parent_level(std::span<const crypto::digest> level) -> std::vector<crypto::digest> {
    std::vector<crypto::digest> parents;
    parents.reserve((level.size() + 1) / 2);
    for (u64 position = 0; position + 1 < level.size(); position += 2) {
        parents.push_back(node_hash(element(level, position), element(level, position + 1)));
    }
    if (level.size() % 2 == 1) {
        parents.push_back(level.back());
    }
    return parents;
}

}

auto leaf_hash(const entry& stored) -> crypto::digest {
    writer bytes;
    bytes.write_u8(leaf_prefix);
    bytes.write_u64(stored.key);
    bytes.write_u8(static_cast<u8>(stored.tag));
    bytes.write_u8(static_cast<u8>(stored.payload.size()));
    bytes.write_bytes(stored.payload);
    return crypto::hash(bytes.bytes());
}

auto tree_root(std::span<const crypto::digest> leaves) -> crypto::digest {
    if (leaves.empty()) {
        return crypto::hash({});
    }
    std::vector<crypto::digest> level(leaves.begin(), leaves.end());
    while (level.size() > 1) {
        level = parent_level(level);
    }
    return level.front();
}

auto proof_for(std::span<const crypto::digest> leaves, std::span<const u32> present)
    -> std::vector<crypto::digest> {
    if (leaves.empty()) {
        return {};
    }
    if (present.empty()) {
        return {tree_root(leaves)};
    }
    std::vector<crypto::digest> proof;
    std::vector<crypto::digest> level(leaves.begin(), leaves.end());
    std::vector<u64> known(present.begin(), present.end());
    while (level.size() > 1) {
        std::vector<u64> parents;
        for (auto at = known.begin(); at != known.end(); ++at) {
            const u64 sibling = *at ^ 1U;
            const bool is_sibling_known = std::next(at) != known.end() && *std::next(at) == sibling;
            if (sibling < level.size() && !is_sibling_known) {
                proof.push_back(element(std::span<const crypto::digest>{level}, sibling));
            }
            if (is_sibling_known) {
                ++at;
            }
            parents.push_back(*at / 2);
        }
        known = std::move(parents);
        level = parent_level(level);
    }
    return proof;
}

auto root_from(
    u32 leaf_count, std::span<const known_leaf> known, std::span<const crypto::digest> proof
) -> result<crypto::digest> {
    constexpr error malformed{.code = error_code::malformed};
    if (leaf_count == 0) {
        if (!known.empty() || !proof.empty()) {
            return std::unexpected(malformed);
        }
        return crypto::hash({});
    }
    if (known.empty()) {
        if (proof.size() != 1) {
            return std::unexpected(malformed);
        }
        return proof.front();
    }
    std::vector<positioned> level;
    level.reserve(known.size());
    for (const known_leaf& leaf : known) {
        level.push_back(positioned{.position = leaf.index, .hash = leaf.hash});
    }
    proof_walk walk{proof};
    for (u64 width = leaf_count; width > 1; width = (width + 1) / 2) {
        level = LUCENT_TRY(walk.parents_of(level, width));
    }
    if (!walk.is_used_up()) {
        return std::unexpected(malformed);
    }
    return level.front().hash;
}

}
