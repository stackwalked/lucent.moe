#include <algorithm>
#include <cstddef>
#include <span>
#include <vector>

#include <lucent/bundle/bundle.hpp>
#include <lucent/fuzzing/run_one.hpp>

// decode_bundle over arbitrary bytes. The format is canonical, so whatever decodes must encode
// back to exactly the input. Seed with contracts/fact-bundle/v1/*.bin.

namespace lucent::fuzzing {

auto run_one(std::span<const std::byte> input) -> void {
    const result<std::vector<bundle::delivered_set>> sets = bundle::decode_bundle(input);
    if (!sets) {
        return;
    }
    LUCENT_INVARIANT(std::ranges::equal(bundle::encode_bundle(*sets), input));
}

}
