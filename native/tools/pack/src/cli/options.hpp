#pragma once

#include <filesystem>
#include <span>

#include <lucent/wire/ids.hpp>

namespace lucent::pack {

// `pack <module.dll> <out.container> --release <32 hex digits>`.
struct options {
    std::filesystem::path module;
    std::filesystem::path container;
    wire::release_id release;
};

// Prints the usage to stderr when the arguments don't fit it.
auto parse_options(std::span<const wchar_t* const> arguments) -> result<options>;

}
