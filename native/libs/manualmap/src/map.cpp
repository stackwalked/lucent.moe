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
#include <vector>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/pe/relocations.hpp>
#include <lucent/pe/tls.hpp>
#include <lucent/wire/container.hpp>

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
            const bool is_rtl_pc_to_file_header = match(
                entry.target,
                [](const pe::import_by_name& by_name) {
                    return by_name.name == "RtlPcToFileHeader";
                },
                [](pe::export_ordinal) { return false; }
            );
            if (is_rtl_pc_to_file_header) {
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
    std::span<const u32> slot_rvas,
    std::span<std::byte> local,
    uptr image_base
) -> result<std::optional<os::remote_region>> {
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
    const u64 image_end = u64{image_base} + local.size();
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

auto page_access_of(wire::section_access access) -> os::page_access {
    switch (access) {
    case wire::section_access::read:
        return os::page_access::read;
    case wire::section_access::read_write:
        return os::page_access::read_write;
    case wire::section_access::read_execute:
        return os::page_access::read_execute;
    }
    LUCENT_UNREACHABLE();
}

// Sections get their access; the pages between and around them, where a PE image keeps its
// headers and discardable sections, get none.
auto protect_container(os::remote_region& region, const wire::container& image) -> result<void> {
    usize cursor = 0;
    for (const wire::container_section& section : image.sections) {
        if (section.rva > cursor) {
            LUCENT_TRY(region.protect(
                {.offset = cursor, .size = section.rva - cursor}, os::page_access::none
            ));
        }
        LUCENT_TRY(region.protect(
            {.offset = section.rva, .size = section.mapped_size}, page_access_of(section.access)
        ));
        cursor = usize{section.rva} + section.mapped_size;
    }
    if (image.image_size > cursor) {
        LUCENT_TRY(region.protect(
            {.offset = cursor, .size = image.image_size - cursor}, os::page_access::none
        ));
    }
    return {};
}

// The container's sections at their RVAs, zeros elsewhere: the image before relocation.
auto container_layout(const wire::container& image) -> std::vector<std::byte> {
    std::vector<std::byte> local(image.image_size);
    for (const wire::container_section& section : image.sections) {
        std::ranges::copy(section.data, local.begin() + narrow<isize>(section.rva));
    }
    return local;
}

// Container slots hold offsets from the base; the image's addresses are those plus the base.
auto apply_container_relocations(
    const wire::container& image, std::span<std::byte> local, uptr base
) -> result<void> {
    for (const u32 slot : image.relocations) {
        const u64 offset = LUCENT_TRY(detail::read_u64(local, slot));
        LUCENT_TRY(detail::write_u64(local, slot, offset + base));
    }
    return {};
}

auto container_rtl_pc_slots(const wire::container& image) -> std::vector<u32> {
    const u64 wanted = wire::import_hash(image.imports_key, "RtlPcToFileHeader");
    std::vector<u32> slots;
    for (const wire::container_import& entry : image.imports) {
        if (entry.function_hash == wanted) {
            slots.push_back(entry.slot_rva);
        }
    }
    return slots;
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
    const std::vector<u32> rtl_pc_slots = LUCENT_TRY(rtl_pc_slot_rvas(image));
    std::optional<os::remote_region> trampolines =
        LUCENT_TRY(install_rtl_pc_trampoline(target, rtl_pc_slots, local, base));
    LUCENT_TRY(image_region.write(0, local));
    LUCENT_TRY(protect_sections(image_region, image));

    const std::optional<pe::directory> exceptions =
        image.find_directory(pe::directory_kind::exceptions);
    return mapped{
        .image = std::move(image_region),
        .trampolines = std::move(trampolines),
        .entry_rva = image.entry_point(),
        .pdata_rva = exceptions.has_value() ? exceptions->rva : 0,
        .pdata_size = exceptions.has_value() ? exceptions->size : 0,
    };
}

auto map_container(const os::process& target, const wire::container& image) -> result<mapped> {
    LUCENT_INVARIANT(wire::is_canonical(image));
    os::remote_region image_region = LUCENT_TRY(
        os::remote_region::allocate(target, image.image_size, os::page_access::read_write)
    );
    const uptr base = image_region.base();
    std::vector<std::byte> local = container_layout(image);
    LUCENT_TRY(apply_container_relocations(image, local, base));
    LUCENT_TRY(detail::bind_hashed_imports(target, image, local));
    std::optional<os::remote_region> trampolines =
        LUCENT_TRY(install_rtl_pc_trampoline(target, container_rtl_pc_slots(image), local, base));
    LUCENT_TRY(image_region.write(0, local));
    LUCENT_TRY(protect_container(image_region, image));
    return mapped{
        .image = std::move(image_region),
        .trampolines = std::move(trampolines),
        .entry_rva = image.entry_rva,
        .pdata_rva = image.pdata_rva,
        .pdata_size = image.pdata_size,
    };
}

auto attach(const os::process& target, const mapped& image, uptr reserved) -> result<void> {
    // The stub calls the entry point unconditionally; an image without one has nothing to attach.
    if (image.entry_rva == 0) {
        return std::unexpected(unsupported);
    }
    const detail::attach_args args{
        .image_base = image.image.base(),
        .entry_point = image.image.base() + image.entry_rva,
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
        // The entry returned a non-BOOL, or the stub was disturbed.
        return std::unexpected(malformed);
    }
}

}
