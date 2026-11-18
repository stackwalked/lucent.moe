#include <lucent/pe/image_view.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>
#include <lucent/core/text.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/pe/relocations.hpp>
#include <lucent/pe/tls.hpp>

#include "images.hpp"

namespace lucent::pe {
namespace {

auto import_slots(const std::vector<import_module>& modules)
    -> std::vector<std::pair<std::string, u32>> {
    std::vector<std::pair<std::string, u32>> slots;
    for (const import_module& module : modules) {
        for (const import_entry& entry : module.entries) {
            slots.emplace_back(module.name, entry.slot_rva);
        }
    }
    return slots;
}

auto is_kernel32(const import_module& module) -> bool {
    const std::wstring name = to_wide(module.name);
    return CompareStringOrdinal(name.c_str(), -1, L"KERNEL32.dll", -1, TRUE) == CSTR_EQUAL;
}

auto slot_value(const image_view& image, u32 rva) -> u64 {
    std::array<std::byte, sizeof(u64)> raw{};
    std::ranges::copy(required(image.bytes_at({.rva = rva, .size = sizeof(u64)})), raw.begin());
    return std::bit_cast<u64>(raw);
}

auto kernel32_exports() -> export_table {
    return required(
        export_table::from_image(
            required(image_view::parse(loaded_image(L"kernel32.dll"), layout::mapped))
        )
    );
}

}

TEST_CASE("a linked image parses with its sections, relocations, imports and exception table") {
    const std::vector<std::byte> file = required(os::read_file(own_path()));
    const image_view image = required(image_view::parse(file, layout::file));

    CHECK(image.entry_point() != 0);
    CHECK(std::ranges::any_of(image.sections(), [](const section& stored) {
        return stored.name == ".text" && stored.access.is_executable;
    }));
    CHECK_FALSE(required(relocations_of(image)).empty());
    CHECK(std::ranges::any_of(required(imports_of(image)), is_kernel32));
    const std::optional<directory> exceptions = image.find_directory(directory_kind::exceptions);
    REQUIRE(exceptions.has_value());
    // .pdata is an array of 12-byte RUNTIME_FUNCTION entries.
    CHECK(exceptions.value_or(directory{}).size % 12 == 0);
}

TEST_CASE(
    "the loaded copy of an image agrees with its file, and the loader filled its import slots"
) {
    const std::vector<std::byte> file = required(os::read_file(own_path()));
    const image_view stored = required(image_view::parse(file, layout::file));
    const image_view loaded = required(image_view::parse(loaded_image(L""), layout::mapped));

    const std::vector<import_module> imports = required(imports_of(loaded));
    CHECK(import_slots(imports) == import_slots(required(imports_of(stored))));
    for (const import_module& module : imports) {
        for (const import_entry& entry : module.entries) {
            CHECK(slot_value(loaded, entry.slot_rva) != 0);
        }
    }
}

TEST_CASE("an export found by name is where GetProcAddress finds it") {
    const export_table exports = kernel32_exports();
    const HMODULE module = GetModuleHandleW(L"kernel32.dll");
    const auto base = std::bit_cast<uptr>(module);
    const usize size = loaded_image(L"kernel32.dll").size();

    for (const std::string_view name :
        {"LoadLibraryW", "GetProcAddress", "CreateThread", "VirtualAlloc"}) {
        const std::string terminated{name};
        const auto found = std::bit_cast<uptr>(GetProcAddress(module, terminated.c_str()));
        match(
            required(exports.find(name)),
            [&](const export_address& address) { CHECK(base + address.rva == found); },
            // A forwarded export resolves into another module.
            [&](const forwarder&) {
                const bool is_elsewhere = found < base || found >= base + size;
                CHECK(is_elsewhere);
            }
        );
    }
}

TEST_CASE("an export's ordinal finds the same export as its name") {
    const export_table exports = kernel32_exports();
    const export_ordinal ordinal = required(exports.ordinal_of("LoadLibraryW"));

    CHECK(required(exports.find(ordinal)) == required(exports.find("LoadLibraryW")));
    const HMODULE module = GetModuleHandleW(L"kernel32.dll");
    const auto* const by_ordinal = std::bit_cast<LPCSTR>(uptr{std::to_underlying(ordinal)});
    CHECK(GetProcAddress(module, by_ordinal) == GetProcAddress(module, "LoadLibraryW"));
}

TEST_CASE("a forwarded export names the module and function it forwards to") {
    // kernel32 has forwarded AcquireSRWLockExclusive to ntdll since Windows Vista.
    const export_target expected{
        forwarder{.module = "NTDLL", .target = std::string{"RtlAcquireSRWLockExclusive"}}
    };
    CHECK(required(kernel32_exports().find("AcquireSRWLockExclusive")) == expected);
}

TEST_CASE("an image without a TLS directory reports none") {
    const image_view kernel32 =
        required(image_view::parse(loaded_image(L"kernel32.dll"), layout::mapped));
    CHECK_FALSE(required(tls_of(kernel32)).has_value());
}

}
