#include <array>
#include <cstddef>
#include <span>
#include <tuple>
#include <vector>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/fuzzing/run_one.hpp>

// verify over every set decode_bundle accepts. A mutated header almost never keeps a valid
// signature, which would stop verify before the Merkle proof, so each set is checked twice: as
// received, and re-signed by the harness's own key so the proof checks run on any header. Seed with
// contracts/fact-bundle/v1/*.bin.

namespace lucent::fuzzing {
namespace {

// Any fixed key: the harness only needs signatures it can make itself.
constexpr crypto::seed harness_seed{};

}

auto run_one(std::span<const std::byte> input) -> void {
    result<std::vector<bundle::delivered_set>> sets = bundle::decode_bundle(input);
    if (!sets) {
        return;
    }
    const crypto::signing_key signer = crypto::signing_key::from_seed(harness_seed);
    const std::array<crypto::public_key, 1> trusted{signer.public_part()};
    for (bundle::delivered_set& set : *sets) {
        std::ignore = bundle::verify(set, trusted);
        set.header.signature = signer.sign(bundle::signed_bytes(set.header));
        std::ignore = bundle::verify(set, trusted);
    }
}

}
