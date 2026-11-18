#include "images.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {
namespace {

auto module_at(const std::filesystem::path& path) -> module_file {
    const result<std::vector<std::byte>> file = os::read_file(path);
    REQUIRE(file.has_value());
    result<module_file> loaded = module_file::load(*file);
    REQUIRE(loaded.has_value());
    return std::move(*loaded);
}

auto game_path() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_FIXTURE_GAME};
}

}

auto own_module() -> module_file {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    return module_at(path);
}

auto own_rva(uptr address) -> u32 {
    const auto base = std::bit_cast<uptr>(GetModuleHandleW(nullptr));
    REQUIRE(address >= base);
    return narrow<u32>(address - base);
}

auto game_module() -> module_file {
    return module_at(game_path());
}

loaded_game::loaded_game() {
    const HMODULE module = LoadLibraryW(game_path().c_str());
    REQUIRE(module != nullptr);
    m_base = std::bit_cast<uptr>(module);
}

loaded_game::~loaded_game() {
    FreeLibrary(std::bit_cast<HMODULE>(m_base));
}

auto loaded_game::object(std::string_view export_name) const -> uptr {
    const std::string name{export_name};
    const auto exported =
        std::bit_cast<uptr>(GetProcAddress(std::bit_cast<HMODULE>(m_base), name.c_str()));
    REQUIRE(exported != 0);
    // The fixture's object getters take nothing and return a pointer.
    const auto getter = std::bit_cast<uptr (*)()>(exported);
    return getter();
}

auto loaded_game::vtable_of(uptr object) const -> u32 {
    // An object's first field is its vtable pointer.
    std::array<std::byte, sizeof(uptr)> raw{};
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // an object of the fixture
    // NOLINTNEXTLINE(performance-no-int-to-ptr): the fixture handed out this object's address.
    const std::span<const std::byte> first_field{
        std::bit_cast<const std::byte*>(object), raw.size()
    };
#pragma clang diagnostic pop
    std::ranges::copy(first_field, raw.begin());
    const auto vtable = std::bit_cast<uptr>(raw);
    REQUIRE(vtable > m_base);
    return narrow<u32>(vtable - m_base);
}

}
