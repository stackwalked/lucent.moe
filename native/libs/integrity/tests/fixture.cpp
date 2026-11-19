#include "fixture.hpp"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <filesystem>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::integrity {

auto load_fixture() -> loaded_fixture {
    const std::filesystem::path path{LUCENT_FIXTURE_IMAGE};
    result<std::vector<std::byte>> file = os::read_file(path);
    REQUIRE(file.has_value());
    loaded_fixture loaded{.module = nullptr, .base = 0, .file = std::move(*file)};
    const pe::image_view view = file_view(loaded);
    // Holding the preferred base makes the loader relocate, whatever ASLR would have picked.
    void* const held = VirtualAlloc(
        std::bit_cast<void*>(view.image_base()), view.size_of_image(), MEM_RESERVE, PAGE_NOACCESS
    );
    REQUIRE(held != nullptr);
    HMODULE const module = LoadLibraryW(path.c_str());
    VirtualFree(held, 0, MEM_RELEASE);
    REQUIRE(module != nullptr);
    loaded.module = module;
    loaded.base = std::bit_cast<uptr>(module);
    REQUIRE(loaded.base != view.image_base());
    return loaded;
}

auto unload(const loaded_fixture& loaded) -> void {
    FreeLibrary(static_cast<HMODULE>(loaded.module));
}

auto file_view(const loaded_fixture& loaded) -> pe::image_view {
    result<pe::image_view> view = pe::image_view::parse(loaded.file, pe::layout::file);
    REQUIRE(view.has_value());
    return std::move(*view);
}

auto export_rva(const loaded_fixture& loaded, std::string_view name) -> u32 {
    const std::string terminated{name};
    const auto found = std::bit_cast<uptr>(
        GetProcAddress(static_cast<HMODULE>(loaded.module), terminated.c_str())
    );
    REQUIRE(found != 0);
    return narrow<u32>(found - loaded.base);
}

auto code_section(const pe::image_view& file) -> pe::rva_range {
    const auto sections = file.sections();
    const auto code = std::ranges::find_if(sections, [](const pe::section& section) {
        return section.access.is_executable;
    });
    REQUIRE(code != sections.end());
    return pe::rva_range{.rva = code->virtual_address, .size = pe::mapped_size_of(*code)};
}

}
