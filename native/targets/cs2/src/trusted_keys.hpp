#pragma once

#include <span>

#include <lucent/crypto/crypto.hpp>

namespace lucent::cs2 {

// The facts keys a bundle may be signed by, static for the module's life. Dev builds and release
// builds each compile their own definition (dev_trusted_keys.cpp, release_trusted_keys.cpp).
auto trusted_keys() -> std::span<const crypto::public_key>;

}
