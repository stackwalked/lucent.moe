#include <lucent/bundle/bundle.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

#include "../src/merkle.hpp"
#include "fixtures.hpp"

namespace lucent::bundle {
namespace {

// RFC 6962's Merkle Tree Hash by its own definition: split at the largest power of two below the
// size. Evaluated with an explicit stack, as an independent reference for the bottom-up tree.
auto reference_root(std::span<const crypto::digest> leaves) -> crypto::digest {
    if (leaves.empty()) {
        return crypto::hash({});
    }

    struct frame {
        usize begin = 0;
        usize end = 0;
        bool is_expanded = false;
    };

    std::vector<frame> pending{frame{.begin = 0, .end = leaves.size(), .is_expanded = false}};
    std::vector<crypto::digest> values;
    while (!pending.empty()) {
        const frame top = pending.back();
        pending.pop_back();
        const usize size = top.end - top.begin;
        if (size == 1) {
            values.push_back(leaves.subspan(top.begin, 1).front());
            continue;
        }
        usize split = 1;
        while (split * 2 < size) {
            split *= 2;
        }
        if (top.is_expanded) {
            const crypto::digest right = values.back();
            values.pop_back();
            const crypto::digest left = values.back();
            values.pop_back();
            std::array<std::byte, 65> bytes{};
            bytes.front() = std::byte{0x01};
            std::ranges::copy(left, bytes.begin() + 1);
            std::ranges::copy(right, bytes.begin() + 33);
            values.push_back(crypto::hash(bytes));
            continue;
        }
        pending.push_back(frame{.begin = top.begin, .end = top.end, .is_expanded = true});
        pending.push_back(frame{.begin = top.begin + split, .end = top.end, .is_expanded = false});
        pending.push_back(
            frame{.begin = top.begin, .end = top.begin + split, .is_expanded = false}
        );
    }
    return values.back();
}

auto keys_of(const fact_set& full, u32 subset) -> std::vector<u64> {
    std::vector<u64> keys;
    for (u32 index = 0; const entry& stored : full.entries) {
        if (((subset >> index) & 1U) != 0) {
            keys.push_back(stored.key);
        }
        ++index;
    }
    return keys;
}

TEST_CASE("the bottom-up tree has RFC 6962's root for every size") {
    for (u32 size = 0; size <= 17; ++size) {
        const fact_set full = fixtures::fact_set_of(size);
        std::vector<crypto::digest> leaves;
        leaves.reserve(full.entries.size());
        for (const entry& stored : full.entries) {
            leaves.push_back(detail::leaf_hash(stored));
        }

        CHECK(full.header.merkle_root == reference_root(leaves));
    }
}

TEST_CASE("every subset of a set's entries proves against its signed root") {
    const std::array<crypto::public_key, 1> trusted{fixtures::signer().public_part()};
    for (u32 size = 0; size <= 8; ++size) {
        const fact_set full = fixtures::fact_set_of(size);
        for (u32 subset = 0; subset < (1U << size); ++subset) {
            const delivered_set given = deliver(full, keys_of(full, subset));

            CHECK(verify(given, trusted).has_value());
        }
    }
}

TEST_CASE("a changed value, key, or proof hash fails verification") {
    const std::array<crypto::public_key, 1> trusted{fixtures::signer().public_part()};
    const fact_set full = fixtures::fact_set_of(9);
    const std::array chosen{full.entries.at(2).key, full.entries.at(7).key};
    const delivered_set honest = deliver(full, chosen);

    delivered_set changed_value = honest;
    changed_value.entries.front().value = literal(changed_value.entries.front().value.key, 0xbad);
    delivered_set changed_key = honest;
    changed_key.entries.front().value.key ^= 1U;
    delivered_set changed_proof = honest;
    changed_proof.proof.front().front() ^= std::byte{0x01};

    CHECK(verify(honest, trusted).has_value());
    CHECK_FALSE(verify(changed_value, trusted).has_value());
    CHECK_FALSE(verify(changed_key, trusted).has_value());
    CHECK_FALSE(verify(changed_proof, trusted).has_value());
}

TEST_CASE("a proof with a hash missing or one left over fails verification") {
    const std::array<crypto::public_key, 1> trusted{fixtures::signer().public_part()};
    const fact_set full = fixtures::fact_set_of(9);
    const std::array chosen{full.entries.at(4).key};
    const delivered_set honest = deliver(full, chosen);

    delivered_set short_proof = honest;
    short_proof.proof.pop_back();
    delivered_set long_proof = honest;
    long_proof.proof.push_back(long_proof.proof.front());

    CHECK_FALSE(verify(short_proof, trusted).has_value());
    CHECK_FALSE(verify(long_proof, trusted).has_value());
}

TEST_CASE("a set signed by a key that isn't trusted fails verification") {
    const fact_set full = fixtures::fact_set_of(3);
    const std::array<crypto::public_key, 1> others{fixtures::other_signer().public_part()};

    CHECK_FALSE(verify(deliver_all(full), others).has_value());
}

TEST_CASE("a bundle decodes to exactly what was encoded") {
    const fact_set full = fixtures::fact_set_of(6);
    const std::array chosen{full.entries.at(1).key, full.entries.at(5).key};
    const std::array sets{deliver_all(full), deliver(full, chosen)};

    const result<std::vector<delivered_set>> decoded = decode_bundle(encode_bundle(sets));

    REQUIRE(decoded.has_value());
    REQUIRE(decoded->size() == 2);
    CHECK(decoded->at(0).entries.size() == 6);
    CHECK(decoded->at(1).entries.size() == 2);
    CHECK(decoded->at(1).proof == sets.at(1).proof);
    CHECK(decoded->at(1).header.signature == full.header.signature);
}

TEST_CASE("a bundle with a byte too many, or of another version, doesn't decode") {
    const std::array sets{deliver_all(fixtures::fact_set_of(2))};
    std::vector<std::byte> trailing = encode_bundle(sets);
    trailing.push_back(std::byte{0});
    std::vector<std::byte> other_version = encode_bundle(sets);
    other_version.at(4) = std::byte{2};

    const result<std::vector<delivered_set>> with_trailing = decode_bundle(trailing);
    const result<std::vector<delivered_set>> with_other_version = decode_bundle(other_version);

    REQUIRE_FALSE(with_trailing.has_value());
    CHECK(with_trailing.error().code == error_code::malformed);
    REQUIRE_FALSE(with_other_version.has_value());
    CHECK(with_other_version.error().code == error_code::version_mismatch);
}

TEST_CASE("entries out of order, or of an unknown payload kind, don't decode") {
    const fact_set full = fixtures::fact_set_of(3);
    delivered_set swapped = deliver_all(full);
    std::swap(swapped.entries.at(0), swapped.entries.at(1));
    delivered_set unknown_kind = deliver_all(full);
    // NOLINTNEXTLINE(clang-analyzer-optin.core.EnumCastOutOfRange): a kind outside the enum is what this test sends.
    unknown_kind.entries.front().value.tag = static_cast<payload_tag>(9);

    CHECK_FALSE(decode_bundle(encode_bundle(std::array{swapped})).has_value());
    CHECK_FALSE(decode_bundle(encode_bundle(std::array{unknown_kind})).has_value());
}

}
}
