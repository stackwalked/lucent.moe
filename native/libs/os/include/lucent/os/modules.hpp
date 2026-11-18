#pragma once

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/os/process.hpp>

namespace lucent::os {

// A module the process's loader knows about. Manually mapped images never appear here.
struct remote_module {
    std::string name;
    std::filesystem::path path;
    uptr base = 0;
    usize size = 0;
};

auto remote_modules(const process& target) -> result<std::vector<remote_module>>;

// By file name ("kernel32.dll"), compared case-insensitively.
auto find_remote_module(const process& target, std::string_view name) -> result<remote_module>;

// By full path, compared case-insensitively.
auto find_remote_module(const process& target, const std::filesystem::path& path)
    -> result<remote_module>;

}
