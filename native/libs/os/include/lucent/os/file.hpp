#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

namespace lucent::os {

auto read_file(const std::filesystem::path& path) -> result<std::vector<std::byte>>;

}
