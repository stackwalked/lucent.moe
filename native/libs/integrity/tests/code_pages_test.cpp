#include <lucent/integrity/code_pages.hpp>

#include <algorithm>
#include <array>
#include <bit>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/os/address_range.hpp>
#include <lucent/pe/image_view.hpp>

#include "fixture.hpp"

namespace lucent::integrity {
namespace {

auto loaded_range(const loaded_fixture& loaded, pe::rva_range range) -> os::address_range {
    return os::address_range{
        .begin = loaded.base + range.rva,
        .end = loaded.base + range.rva + range.size,
    };
}

auto data_section(const pe::image_view& file) -> pe::rva_range {
    const auto sections = file.sections();
    const auto data = std::ranges::find_if(sections, [](const pe::section& section) {
        return !section.access.is_executable && !section.access.is_writable;
    });
    REQUIRE(data != sections.end());
    return pe::rva_range{.rva = data->virtual_address, .size = pe::mapped_size_of(*data)};
}

TEST_CASE("loaded code is sealed until one of its pages is made writable") {
    const loaded_fixture loaded = load_fixture();
    const os::address_range code = loaded_range(loaded, code_section(file_view(loaded)));
    const std::array ranges{code};
    REQUIRE(is_code_sealed(ranges));

    DWORD previous = 0;
    auto* const page = std::bit_cast<void*>(code.begin);
    REQUIRE(VirtualProtect(page, 1, PAGE_EXECUTE_READWRITE, &previous) != 0);
    CHECK_FALSE(is_code_sealed(ranges));

    REQUIRE(VirtualProtect(page, 1, previous, &previous) != 0);
    CHECK(is_code_sealed(ranges));
    unload(loaded);
}

TEST_CASE("constant data is not sealed code, since it doesn't execute") {
    const loaded_fixture loaded = load_fixture();
    const std::array ranges{loaded_range(loaded, data_section(file_view(loaded)))};

    CHECK_FALSE(is_code_sealed(ranges));
    unload(loaded);
}

TEST_CASE("reserved but uncommitted memory is not sealed") {
    constexpr usize size = 0x10000;
    void* const reserved = VirtualAlloc(nullptr, size, MEM_RESERVE, PAGE_EXECUTE_READ);
    REQUIRE(reserved != nullptr);
    const auto begin = std::bit_cast<uptr>(reserved);
    const std::array ranges{os::address_range{.begin = begin, .end = begin + size}};

    CHECK_FALSE(is_code_sealed(ranges));
    VirtualFree(reserved, 0, MEM_RELEASE);
}

}
}
