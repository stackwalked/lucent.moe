#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <variant>

namespace lucent::facts {

// `facts ingest --target <name>`: snapshot the installed game's modules into the binaries cache.
struct ingest_command {
    std::string target;
};

// `facts generate --target <name> <module.dll>`: derive the facts that module links from the
// cache's latest builds.
struct generate_command {
    std::string target;
    std::filesystem::path module;
};

// `facts manifest --target <name> <module.dll> <out>`: write the release manifest of that module
// for the target's game.
struct manifest_command {
    std::string target;
    std::filesystem::path module;
    std::filesystem::path out;
};

// `facts check --target <name> <module.dll>`: the release build's post-link step; fails when the
// image holds a declared fact name.
struct check_command {
    std::string target;
    std::filesystem::path module;
};

using command = std::variant<ingest_command, generate_command, manifest_command, check_command>;

// Prints the usage to stderr when the arguments don't fit it.
auto parse_command(std::span<const wchar_t* const> arguments) -> result<command>;

}
