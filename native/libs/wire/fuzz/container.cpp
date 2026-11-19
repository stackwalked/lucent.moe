#include <lucent/wire/container.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <tuple>

#include <lucent/crypto/crypto.hpp>
#include <lucent/fuzzing/run_one.hpp>
#include <lucent/wire/container_stream.hpp>
#include <lucent/wire/release_seal.hpp>

// The container's decoders and the seal's over arbitrary bytes: the body, the packed form (LZ4
// decompression of hostile blocks), the stream opener and the seal. The body and the seal are
// canonical, so whatever decodes must encode back to exactly the input. The packed form is pinned
// by the seal's digest instead: what unpacks must pack to a body that decodes the same. Seed with
// contracts/container/v1/*.bin, contracts/container-stream/v1/*.bin and
// contracts/release-seal/v1/*.bin.

namespace lucent::fuzzing {

auto run_one(std::span<const std::byte> input) -> void {
    const result<wire::container> body = wire::decode_container_body(input);
    if (body) {
        LUCENT_INVARIANT(std::ranges::equal(wire::encode_container_body(*body), input));
    }
    const result<wire::container> unpacked = wire::unpack_container(input);
    if (unpacked) {
        LUCENT_INVARIANT(wire::unpack_container(wire::pack_container(*unpacked)) == unpacked);
    }
    const result<wire::release_seal> seal = wire::decode_release_seal(input);
    if (seal) {
        LUCENT_INVARIANT(std::ranges::equal(wire::encode_release_seal(*seal), input));
    }
    std::array<std::byte, crypto::secret_key_size> zero{};
    const crypto::secret_key key = crypto::secret_key::from_bytes(zero);
    std::ignore = wire::open_container_stream(key, input);
}

}
