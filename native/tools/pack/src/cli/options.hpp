#pragma once

#include <filesystem>
#include <span>

#include <lucent/wire/ids.hpp>

#include "image/convert.hpp"

namespace lucent::pack {

// `pack <module.dll> <out.container> --release <32 hex digits> [--require-boot]`.
struct options {
    std::filesystem::path module;
    std::filesystem::path container;
    wire::release_id release;
    boot_entry boot = boot_entry::optional;
};

// Prints the usage to stderr when the arguments don't fit it.
auto parse_options(std::span<const wchar_t* const> arguments) -> result<options>;

}
