#pragma once

#include <string_view>

#include <lucent/crypto/crypto.hpp>

namespace lucent::codekey {

// One line, as UTF-8, prompted for on stderr: from the console with echo off, or from standard
// input when it isn't one (a pipe, for scripted signing). Never from the command line, where
// other processes and shell history can read it. Wiped with the returned bytes.
auto read_passphrase(std::string_view prompt) -> result<crypto::secret_bytes>;

}
