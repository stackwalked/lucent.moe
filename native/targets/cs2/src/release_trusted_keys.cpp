#include <span>

#include <lucent/crypto/crypto.hpp>

#include "trusted_keys.hpp"

namespace lucent::cs2 {

// None until the production facts key list lands (phase 1's release tooling): no bundle applies, so
// every core capability fails and each start is refused as GAME_BUILD_UNSUPPORTED.
auto trusted_keys() -> std::span<const crypto::public_key> {
    return {};
}

}
