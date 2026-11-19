#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <variant>

namespace lucent::factgen {

// `factgen ingest --target <name>`: snapshot the installed game's modules into the binaries cache.
struct ingest_command {
    std::string target;
};

// `factgen generate --target <name> <module.dll>`: derive the facts that module links from the
// cache's latest builds.
struct generate_command {
    std::string target;
    std::filesystem::path module;
};

using command = std::variant<ingest_command, generate_command>;

// Prints the usage to stderr when the arguments don't fit it.
auto parse_command(std::span<const wchar_t* const> arguments) -> result<command>;

}
