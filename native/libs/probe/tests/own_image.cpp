#include "own_image.hpp"

#include <bit>
#include <cstddef>
#include <string>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

auto own_module() -> module_file {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    const result<std::vector<std::byte>> file = os::read_file(path);
    REQUIRE(file.has_value());
    result<module_file> loaded = module_file::load(*file);
    REQUIRE(loaded.has_value());
    return std::move(*loaded);
}

auto own_rva(uptr address) -> u32 {
    const auto base = std::bit_cast<uptr>(GetModuleHandleW(nullptr));
    REQUIRE(address >= base);
    return narrow<u32>(address - base);
}

}
