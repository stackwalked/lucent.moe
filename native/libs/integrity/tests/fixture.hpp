#pragma once

#include <cstddef>
#include <string_view>
#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::integrity {

// The fixture image, loaded by the OS loader at a base other than its preferred one so that every
// relocation in it moves.
struct loaded_fixture {
    void* module = nullptr;
    uptr base = 0;
    std::vector<std::byte> file;
};

auto load_fixture() -> loaded_fixture;
auto unload(const loaded_fixture& loaded) -> void;

// The fixture's file, parsed; it borrows the loaded fixture's bytes.
auto file_view(const loaded_fixture& loaded) -> pe::image_view;

auto export_rva(const loaded_fixture& loaded, std::string_view name) -> u32;

// The fixture's code section, as an address range from its base.
auto code_section(const pe::image_view& file) -> pe::rva_range;

}
