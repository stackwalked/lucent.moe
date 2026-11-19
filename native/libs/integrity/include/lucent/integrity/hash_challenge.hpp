#pragma once

#include <array>
#include <cstddef>
#include <span>

#include <lucent/crypto/crypto.hpp>
#include <lucent/os/address_range.hpp>

namespace lucent::integrity {

inline constexpr usize nonce_size = 32;

using nonce = std::array<std::byte, nonce_size>;

// BLAKE2b-256 of the covered bytes keyed by the nonce (RFC 7693), as the server computes it too.
auto answer(const nonce& key, std::span<const std::byte> covered) -> crypto::digest;

// The same over a range of this process's memory, read where it lies: the range must be readable
// and stay mapped for the call.
auto answer(const nonce& key, os::address_range covered) -> crypto::digest;

}
