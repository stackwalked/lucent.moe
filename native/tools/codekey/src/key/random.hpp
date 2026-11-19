#pragma once

#include <cstddef>
#include <span>

namespace lucent::codekey {

// From the system's preferred CSPRNG (BCryptGenRandom).
auto fill_random(std::span<std::byte> out) -> result<void>;

}
