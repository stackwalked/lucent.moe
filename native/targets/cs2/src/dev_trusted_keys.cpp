#include <array>
#include <span>

#include <lucent/crypto/crypto.hpp>
#include <lucent/devkey/public_key.hpp>

#include "trusted_keys.hpp"

namespace lucent::cs2 {
namespace {

// Dev builds trust this machine's dev key and nothing else (tools/devkey).
constexpr std::array<crypto::public_key, 1> dev_keys{devkey::public_key};

}

auto trusted_keys() -> std::span<const crypto::public_key> {
    return dev_keys;
}

}
