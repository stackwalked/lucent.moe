#include <lucent/manualmap/map.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <tuple>
#include <utility>
#include <variant>
#include <vector>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/pe/relocations.hpp>
#include <lucent/pe/runtime_functions.hpp>
#include <lucent/pe/tls.hpp>

#include "image_bytes.hpp"
#include "imports.hpp"
#include "stubs.hpp"

namespace lucent::manualmap {
namespace {

constexpr error malformed{.code = error_code::malformed};
constexpr error unsupported{.code = error_code::unsupported};

// DllMain returned FALSE. The Windows loader reports this to its caller as this system code.
constexpr u32 error_dll_init_failed = 1114;

auto page_access_of(const pe::section_access& access) -> os::page_access {
    if (access.is_executable) {
        return access.is_writable ? os::page_access::read_write_execute
                                  : os::page_access::read_execute;
    }
    if (access.is_writable) {
        return os::page_access::read_write;
    }
    if (access.is_readable) {
        return os::page_access::read;
    }
    return os::page_access::none;
}

auto apply_relocations(const pe::image_view& image, std::span<std::byte> local, uptr new_base)
    -> result<void> {
    const u64 delta = u64{new_base} - image.image_base();
    if (delta == 0) {
        return {};
    }
    for (const u32 slot : LUCENT_TRY(pe::relocations_of(image))) {
        const u64 original = LUCENT_TRY(detail::read_u64(local, slot));
        LUCENT_TRY(detail::write_u64(local, slot, original + delta));
    }
    return {};
}

auto rtl_pc_slot_rvas(const pe::image_view& image) -> result<std::vector<u32>> {
    std::vector<u32> rvas;
    for (const pe::import_module& module : LUCENT_TRY(pe::imports_of(image))) {
        for (const pe::import_entry& entry : module.entries) {
            const auto* by_name = std::get_if<pe::import_by_name>(&entry.target);
            if (by_name != nullptr && by_name->name == "RtlPcToFileHeader") {
                rvas.push_back(entry.slot_rva);
            }
        }
    }
    return rvas;
}

// build: Windows x64, static CRT from VS 18 (MSVC 14.51)
// found: the module's import table lists KERNEL32!RtlPcToFileHeader; the CRT's x64
//        _CxxThrowException asks it for the ThrowInfo image base
// breaks: C++ catch by type inside a mapped image (the loader doesn't know the image, so the real
//         function returns null and type matching uses base 0)
auto install_rtl_pc_trampoline(
    const os::process& target,
    const pe::image_view& image,
    std::span<std::byte> local,
    uptr image_base
) -> result<std::optional<os::remote_region>> {
    const std::vector<u32> slot_rvas = LUCENT_TRY(rtl_pc_slot_rvas(image));
    if (slot_rvas.empty()) {
        return std::nullopt;
    }
    // bind_imports already wrote the real address into every slot; all RtlPcToFileHeader slots
    // get the same address.
    const u64 real_address = LUCENT_TRY(detail::read_u64(local, slot_rvas.front()));

    os::remote_region region = LUCENT_TRY(
        os::remote_region::allocate(target, detail::trampoline_size, os::page_access::read_write)
    );
    std::array<std::byte, detail::trampoline_size> trampoline{};
    const std::span<const std::byte> bytes =
        std::as_bytes(std::span{detail::rtl_pc_trampoline_bytes});
    std::ranges::copy(bytes, trampoline.begin());
    const u64 image_end = u64{image_base} + image.size_of_image();
    const auto base_bytes = std::bit_cast<std::array<std::byte, 8>>(u64{image_base});
    const auto end_bytes = std::bit_cast<std::array<std::byte, 8>>(image_end);
    const auto original_bytes = std::bit_cast<std::array<std::byte, 8>>(real_address);
    std::ranges::copy(base_bytes, trampoline.begin() + detail::trampoline_image_base_offset);
    std::ranges::copy(end_bytes, trampoline.begin() + detail::trampoline_image_end_offset);
    std::ranges::copy(original_bytes, trampoline.begin() + detail::trampoline_original_offset);
    LUCENT_TRY(region.write(0, trampoline));
    LUCENT_TRY(region.protect(
        {.offset = 0, .size = detail::trampoline_size}, os::page_access::read_execute
    ));

    for (const u32 slot : slot_rvas) {
        LUCENT_TRY(detail::write_u64(local, slot, region.base()));
    }
    return region;
}

auto protect_sections(os::remote_region& region, const pe::image_view& image) -> result<void> {
    LUCENT_TRY(
        region.protect({.offset = 0, .size = image.size_of_headers()}, os::page_access::read)
    );
    for (const pe::section& stored : image.sections()) {
        LUCENT_TRY(region.protect(
            {.offset = stored.virtual_address, .size = pe::mapped_size_of(stored)},
            page_access_of(stored.access)
        ));
    }
    return {};
}

// ntdll is at the same base in every process of a boot (ASLR picks it once per boot), just as
// kernel32 is in os/src/remote_call.cpp: the address we read here is its address in the target too.
auto ntdll_address(const char* name) -> result<uptr> {
    const auto address = std::bit_cast<uptr>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), name));
    if (address == 0) {
        return std::unexpected(last_system_error());
    }
    return address;
}

}

auto map(const os::process& target, std::span<const std::byte> image_file) -> result<mapped> {
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(image_file, pe::layout::file));
    if (LUCENT_TRY(pe::tls_of(image)).has_value()) {
        return std::unexpected(unsupported);
    }
    os::remote_region image_region = LUCENT_TRY(
        os::remote_region::allocate(target, image.size_of_image(), os::page_access::read_write)
    );
    const uptr base = image_region.base();
    std::vector<std::byte> local = LUCENT_TRY(pe::to_mapped_layout(image));
    LUCENT_TRY(apply_relocations(image, local, base));
    LUCENT_TRY(detail::bind_imports(target, image, local));
    std::optional<os::remote_region> trampolines =
        LUCENT_TRY(install_rtl_pc_trampoline(target, image, local, base));
    LUCENT_TRY(image_region.write(0, local));
    LUCENT_TRY(protect_sections(image_region, image));

    const std::optional<pe::directory> exceptions =
        image.find_directory(pe::directory_kind::exceptions);
    const uptr entry_absolute = image.entry_point() == 0 ? 0 : base + image.entry_point();
    const uptr exception_absolute = exceptions.has_value() ? base + exceptions->rva : 0;
    const u32 exception_entries = narrow<u32>(LUCENT_TRY(pe::runtime_functions_of(image)).size());
    return mapped{
        .image = std::move(image_region),
        .trampolines = std::move(trampolines),
        .entry_point = entry_absolute,
        .exception_table = exception_absolute,
        .exception_count = exception_entries,
    };
}

auto attach(const os::process& target, const mapped& image, uptr reserved) -> result<void> {
    // The stub calls the entry point unconditionally; an image without one has nothing to attach.
    if (image.entry_point == 0) {
        return std::unexpected(unsupported);
    }
    const uptr add_function_table = LUCENT_TRY(ntdll_address("RtlAddFunctionTable"));
    const detail::attach_args args{
        .function_table = image.exception_table,
        .function_count = image.exception_count,
        .image_base = image.image.base(),
        .add_function_table = add_function_table,
        .entry_point = image.entry_point,
        .reserved = reserved,
    };
    os::remote_region region = LUCENT_TRY(
        os::remote_region::allocate(target, detail::attach_region_size, os::page_access::read_write)
    );
    LUCENT_TRY(region.write(0, std::as_bytes(std::span{detail::attach_stub_bytes})));
    LUCENT_TRY(region.write(detail::attach_args_offset, std::as_bytes(std::span{&args, 1})));
    LUCENT_TRY(region.protect(
        {.offset = 0, .size = detail::attach_region_size}, os::page_access::read_execute
    ));
    const result<u32> ran = os::run_remote(
        target, {.start = region.base(), .argument = region.base() + detail::attach_args_offset}
    );
    if (!ran) {
        // After a timeout the entry point may still be running with the stub's return address on
        // its stack; freeing the stub would crash the target when it returns. Leak the page
        // instead.
        std::ignore = region.release();
        return std::unexpected(ran.error());
    }
    switch (*ran) {
    case 1:
        return {};
    case 0:
        // DllMain returned FALSE.
        return std::unexpected(
            error{.code = error_code::system, .system_code = error_dll_init_failed}
        );
    default:
        // 2 is RtlAddFunctionTable rejecting the exception table (no Windows code is set);
        // anything else means the entry returned a non-BOOL or the stub was disturbed.
        return std::unexpected(malformed);
    }
}

}
