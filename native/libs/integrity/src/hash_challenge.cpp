#include <lucent/integrity/hash_challenge.hpp>

#include <bit>
#include <cstddef>
#include <span>

#include <lucent/crypto/crypto.hpp>
#include <lucent/os/address_range.hpp>

namespace lucent::integrity {

// BLAKE2b's own keyed mode: the standard construction every implementation the server might use
// has, and the covered bytes are hashed where they lie.
auto answer(const nonce& key, std::span<const std::byte> covered) -> crypto::digest {
    return crypto::keyed_hash(key, covered);
}

auto answer(const nonce& key, os::address_range covered) -> crypto::digest {
    LUCENT_INVARIANT(covered.begin <= covered.end);
    const auto* const first = std::bit_cast<const std::byte*>(covered.begin);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // the caller's mapped range
    return answer(key, std::span<const std::byte>{first, covered.end - covered.begin});
#pragma clang diagnostic pop
}

}
