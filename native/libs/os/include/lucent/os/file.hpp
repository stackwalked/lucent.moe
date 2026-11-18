#pragma once

#include <cstddef>
#include <filesystem>
#include <span>
#include <vector>

namespace lucent::os {

auto read_file(const std::filesystem::path& path) -> result<std::vector<std::byte>>;

// Creates or replaces the file with exactly these bytes.
auto write_file(const std::filesystem::path& path, std::span<const std::byte> bytes)
    -> result<void>;

}
