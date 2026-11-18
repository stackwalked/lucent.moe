#pragma once

#include <filesystem>
#include <span>
#include <string>

namespace lucent::loader_dev {

struct options {
    std::filesystem::path module;
    std::string process = "cs2.exe";
};

// Prints the usage line to stderr when the arguments don't fit it.
auto parse_options(std::span<const wchar_t* const> arguments) -> result<options>;

}
