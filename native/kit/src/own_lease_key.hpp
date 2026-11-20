#pragma once

#include <optional>

#include <lucent/crypto/crypto.hpp>

namespace lucent::kit::detail {

// The public half of the online lease key, which signs every lease and the session key exchange:
// a Release build compiles in the tree's LUCENT_LEASE_PUBLIC_KEY, which CMake refuses to leave
// empty or set to the dev key. Dev builds hold no lease and trust none.
auto own_lease_key() -> std::optional<crypto::public_key>;

}
