#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

// The OS loader locks the file it loads, so the module runs from a copy and the build stays free
// to overwrite the original. The bytes are read from that copy, so what is parsed from them is
// what the loader maps.
struct staged_module {
    std::filesystem::path copy;
    std::vector<std::byte> file;
};

// Copies left by earlier runs are removed once nothing holds them.
auto stage_module(const std::filesystem::path& module) -> result<staged_module>;

// Returns the base the target's loader mapped the copy at.
auto load_staged_module(const os::process& target, const staged_module& staged) -> result<uptr>;

}
