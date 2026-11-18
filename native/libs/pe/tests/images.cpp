#include "images.hpp"

#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

auto own_path() -> std::filesystem::path {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    return path;
}

auto loaded_image(std::wstring_view module) -> std::span<const std::byte> {
    const std::wstring name{module};
    const HMODULE base =
        module.empty() ? GetModuleHandleW(nullptr) : GetModuleHandleW(name.c_str());
    REQUIRE(base != nullptr);
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): an HMODULE is its image base.
    const auto* const first = reinterpret_cast<const std::byte*>(base);
    // A loaded image is readable from its base to SizeOfImage; the headers say how far that is.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // loader-mapped range
    const std::span<const std::byte> header_page{first, 0x1000};
    const image_view headers = required(image_view::parse(header_page, layout::mapped));
    return std::span<const std::byte>{first, headers.size_of_image()};
#pragma clang diagnostic pop
}

}
