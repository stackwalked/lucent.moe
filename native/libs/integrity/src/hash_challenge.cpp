#include <lucent/integrity/hash_challenge.hpp>

#include <bit>
#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/os/address_range.hpp>

namespace lucent::integrity {

// The nonce leads the message rather than keying BLAKE2b natively: lucent::crypto has no keyed
// form, and BLAKE2b has no length extension, so a secret prefix keys it as well. The copy is the
// cost; challenges cover small ranges.
auto answer(const nonce& key, std::span<const std::byte> covered) -> crypto::digest {
    std::vector<std::byte> message;
    message.reserve(key.size() + covered.size());
    message.append_range(key);
    message.append_range(covered);
    return crypto::hash(message);
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
