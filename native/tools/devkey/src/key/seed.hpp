#pragma once

#include <lucent/crypto/crypto.hpp>

namespace lucent::devkey {

// This machine's dev signing key, from the seed at %LOCALAPPDATA%\lucent\dev\fact-signing.seed.
// A missing seed is created from the system's RNG; builds racing to create it agree on whichever
// lands first. A seed of the wrong size is left alone and fails as malformed: replacing it is a
// person's call, since every dev bundle signed with it stops verifying.
auto dev_signing_key() -> result<crypto::signing_key>;

}
