#include <lucent/bundle/release_manifest.hpp>

#include <algorithm>
#include <cstddef>
#include <span>

#include <lucent/fuzzing/run_one.hpp>

// Each version's release manifest decoder over arbitrary bytes. The format is canonical, so
// whatever decodes must encode back to exactly the input, and the encoder's own canonical check
// must hold for it. Seed with contracts/release-manifest/v1/*.bin, v2/*.bin and v3/*.bin.

namespace lucent::fuzzing {

auto run_one(std::span<const std::byte> input) -> void {
    const result<bundle::release_manifest> manifest = bundle::decode_release_manifest(input);
    if (manifest) {
        LUCENT_INVARIANT(std::ranges::equal(bundle::encode_release_manifest(*manifest), input));
    }
    const result<bundle::release_manifest_v2> second = bundle::decode_release_manifest_v2(input);
    if (second) {
        LUCENT_INVARIANT(std::ranges::equal(bundle::encode_release_manifest_v2(*second), input));
    }
    const result<bundle::release_manifest_v3> third = bundle::decode_release_manifest_v3(input);
    if (third) {
        LUCENT_INVARIANT(std::ranges::equal(bundle::encode_release_manifest_v3(*third), input));
    }
}

}
