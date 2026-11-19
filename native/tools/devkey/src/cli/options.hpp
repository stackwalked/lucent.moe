#pragma once

#include <filesystem>
#include <span>
#include <variant>

#include "sign/dev_bundle.hpp"

namespace lucent::devkey {

// `devkey header <out.hpp>`: the build's step, emitting the public key.
struct header_command {
    std::filesystem::path header;
};

// `devkey sign <module.dll> <game-module.dll> <out.bundle> <name>=<value>|@<file>...`; a file is
// The facts tool's values, one name=value per line.
struct sign_command {
    dev_bundle_request request;
    std::filesystem::path bundle;
};

// `devkey check <module.dll>`: the release build's post-link step; fails when the image holds this
// machine's dev public key.
struct check_command {
    std::filesystem::path module;
};

using command = std::variant<header_command, sign_command, check_command>;

// Prints the usage to stderr when the arguments don't fit it.
auto parse_command(std::span<const wchar_t* const> arguments) -> result<command>;

}
