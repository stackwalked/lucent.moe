#pragma once

#include <filesystem>

#include <lucent/crypto/crypto.hpp>

namespace lucent::devkey {

// Writes <lucent/devkey/public_key.hpp>, which defines lucent::devkey::public_key. Leaves the file
// untouched when it already says the same, so a build that runs this every time rebuilds nothing.
auto write_public_key_header(const std::filesystem::path& header, const crypto::public_key& key)
    -> result<void>;

}
