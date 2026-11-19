#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <variant>

#include <lucent/wire/ids.hpp>

namespace lucent::codekey {

// `codekey create <key file>`: a new offline code key, sealed under a passphrase asked for twice.
struct create_command {
    std::filesystem::path key_file;
};

// `codekey public <key file>`: the key's public half, as the server's LUCENT_CODE_PUBLIC_KEY.
struct public_command {
    std::filesystem::path key_file;
};

// `codekey sign-module <key file> <out.seal> <product> <channel> <number> <container>
// <manifest>`: the release id and boot_info version come from the container itself.
struct sign_module_command {
    std::filesystem::path key_file;
    std::filesystem::path seal;
    std::string product;
    wire::channel chosen = wire::channel::stable;
    u64 number = 0;
    std::filesystem::path container;
    std::filesystem::path manifest;
};

// `codekey sign-loader <key file> <out.seal> <channel> <number> <release> <boot_info version>
// <loader.exe> <host.exe>`.
struct sign_loader_command {
    std::filesystem::path key_file;
    std::filesystem::path seal;
    wire::channel chosen = wire::channel::stable;
    u64 number = 0;
    wire::release_id release;
    u32 boot_info_version = 0;
    std::filesystem::path loader;
    std::filesystem::path host;
};

using command =
    std::variant<create_command, public_command, sign_module_command, sign_loader_command>;

// Prints the usage to stderr when the arguments don't fit it.
auto parse_command(std::span<const wchar_t* const> arguments) -> result<command>;

}
