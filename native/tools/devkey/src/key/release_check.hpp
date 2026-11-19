#pragma once

#include <filesystem>
#include <optional>

#include <lucent/crypto/crypto.hpp>

namespace lucent::devkey {

// Where the module file holds the key's bytes, if anywhere: a release build runs this after
// linking and fails on any offset, since a release that trusts the dev key accepts every bundle
// this machine signs.
auto public_key_offset(const std::filesystem::path& module, const crypto::public_key& key)
    -> result<std::optional<isize>>;

}
