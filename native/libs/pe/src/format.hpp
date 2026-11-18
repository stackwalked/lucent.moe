#pragma once

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>
#include <type_traits>

#include <lucent/pe/image_view.hpp>

// The PE32+ on-disk structures this library reads, mirrored field for field.
// build: PE32+ as specified for x64; the format is versioned by its own fields, not by OS build
// found: Microsoft's "PE Format" specification (learn.microsoft.com/windows/win32/debug/pe-format)
// breaks: images fail to parse, as malformed or unsupported; nothing is read outside the input
namespace lucent::pe::detail {

inline constexpr u16 dos_magic = 0x5a4d;
inline constexpr usize new_header_offset_field = 0x3c;
inline constexpr u32 nt_signature = 0x0000'4550;
inline constexpr u16 machine_amd64 = 0x8664;
inline constexpr u16 optional_magic_pe32_plus = 0x20b;
inline constexpr usize max_directories = 16;
// The specification's limit on sections.
inline constexpr u16 max_sections = 96;

inline constexpr u32 section_readable = 0x4000'0000;
inline constexpr u32 section_writable = 0x8000'0000;
inline constexpr u32 section_executable = 0x2000'0000;

inline constexpr u16 relocation_absolute = 0;
inline constexpr u16 relocation_dir64 = 10;
inline constexpr u64 import_by_ordinal = u64{1} << 63U;

struct raw_file_header {
    u16 machine;
    u16 section_count;
    u32 time_date_stamp;
    u32 symbol_table;
    u32 symbol_count;
    u16 optional_header_size;
    u16 characteristics;
};

struct raw_optional_header {
    u16 magic;
    u8 major_linker_version;
    u8 minor_linker_version;
    u32 size_of_code;
    u32 size_of_initialized_data;
    u32 size_of_uninitialized_data;
    u32 entry_point;
    u32 base_of_code;
    u64 image_base;
    u32 section_alignment;
    u32 file_alignment;
    std::array<u16, 6> versions;
    u32 win32_version;
    u32 size_of_image;
    u32 size_of_headers;
    u32 checksum;
    u16 subsystem;
    u16 dll_characteristics;
    u64 stack_reserve;
    u64 stack_commit;
    u64 heap_reserve;
    u64 heap_commit;
    u32 loader_flags;
    u32 directory_count;
};

struct raw_section_header {
    std::array<char, 8> name;
    u32 virtual_size;
    u32 virtual_address;
    u32 raw_size;
    u32 raw_offset;
    u32 relocations;
    u32 line_numbers;
    u16 relocation_count;
    u16 line_number_count;
    u32 characteristics;
};

struct raw_export_directory {
    u32 characteristics;
    u32 time_date_stamp;
    u16 major_version;
    u16 minor_version;
    u32 name;
    u32 ordinal_base;
    u32 function_count;
    u32 name_count;
    u32 functions;
    u32 names;
    u32 name_ordinals;
};

struct raw_import_descriptor {
    u32 lookup_table;
    u32 time_date_stamp;
    u32 forwarder_chain;
    u32 name;
    u32 address_table;
};

struct raw_tls_directory {
    u64 raw_data_start;
    u64 raw_data_end;
    u64 index_address;
    u64 callbacks_address;
    u32 zero_fill_size;
    u32 characteristics;
};

struct raw_relocation_block {
    u32 page_rva;
    u32 block_size;
};

struct raw_runtime_function {
    u32 begin;
    u32 end;
    u32 unwind_info;
};

static_assert(sizeof(raw_file_header) == 20, "IMAGE_FILE_HEADER is 20 bytes");
static_assert(
    sizeof(raw_optional_header) == 112,
    "IMAGE_OPTIONAL_HEADER64 has 112 bytes before its directories"
);
static_assert(offsetof(raw_optional_header, image_base) == 24, "PE32+ ImageBase is at 24");
static_assert(offsetof(raw_optional_header, size_of_image) == 56, "PE32+ SizeOfImage is at 56");
static_assert(
    offsetof(raw_optional_header, directory_count) == 108, "PE32+ NumberOfRvaAndSizes is at 108"
);
static_assert(sizeof(raw_section_header) == 40, "IMAGE_SECTION_HEADER is 40 bytes");
static_assert(sizeof(raw_export_directory) == 40, "IMAGE_EXPORT_DIRECTORY is 40 bytes");
static_assert(sizeof(raw_import_descriptor) == 20, "IMAGE_IMPORT_DESCRIPTOR is 20 bytes");
static_assert(sizeof(raw_tls_directory) == 40, "IMAGE_TLS_DIRECTORY64 is 40 bytes");
static_assert(sizeof(raw_relocation_block) == 8, "IMAGE_BASE_RELOCATION is 8 bytes");
static_assert(
    sizeof(raw_runtime_function) == 12, "IMAGE_RUNTIME_FUNCTION_ENTRY is 12 bytes on x64"
);

inline constexpr error malformed{.code = error_code::malformed};

template <typename T>
concept trivially_copyable = std::is_trivially_copyable_v<T>;

template <trivially_copyable T>
auto read_at(std::span<const std::byte> bytes, usize offset) -> result<T> {
    if (offset > bytes.size() || sizeof(T) > bytes.size() - offset) {
        return std::unexpected(malformed);
    }
    std::array<std::byte, sizeof(T)> raw{};
    std::ranges::copy(bytes.subspan(offset, sizeof(T)), raw.begin());
    return std::bit_cast<T>(raw);
}

template <trivially_copyable T>
auto read_rva(const image_view& image, u32 rva) -> result<T> {
    const std::span<const std::byte> bytes =
        LUCENT_TRY(image.bytes_at({.rva = rva, .size = sizeof(T)}));
    return read_at<T>(bytes, 0);
}

}
