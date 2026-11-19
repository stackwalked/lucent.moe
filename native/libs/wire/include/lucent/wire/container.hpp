#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/wire/ids.hpp>

// The module container (contracts/container/v1): a module image laid out for mapping, written from
// the linked DLL by the release build (tools/pack) and mapped by the loader (manualmap). No PE
// headers, names, timestamps or linker fields: sections at their RVAs with their final access,
// relocation slots, imports as keyed hashes, and .pdata's place.
//
// The release seal carries the digest of the packed bytes; the loader decrypts the stream, checks
// that digest, and only then unpacks and decodes.

namespace lucent::wire {

inline constexpr u32 container_page_size = 0x1000;
inline constexpr u32 max_container_image_size = u32{256} << 20U;
inline constexpr usize import_key_size = 32;

using import_key = std::array<std::byte, import_key_size>;

// A section's access once mapped. Never writable and executable at once.
enum class section_access : u8 {
    read = 1,
    read_write = 2,
    read_execute = 3,
};

struct container_section {
    // Page-aligned.
    u32 rva = 0;
    // Page-aligned and non-zero: the address space the section takes.
    u32 mapped_size = 0;
    section_access access = section_access::read;
    // The section's first bytes, a whole number of pages at most mapped_size long, its last page
    // not all zero; the rest of mapped_size is zero.
    std::vector<std::byte> data;

    auto operator==(const container_section&) const -> bool = default;
};

// One import: which module and which of its exports, as import_hash gives them, and the 8-byte
// slot the export's address goes into.
struct container_import {
    u64 module_hash = 0;
    u64 function_hash = 0;
    u32 slot_rva = 0;

    auto operator==(const container_import&) const -> bool = default;
};

struct container {
    release_id release;
    // Page-aligned, at most max_container_image_size.
    u32 image_size = 0;
    // The image's entry point (the CRT's DllMain), in an executable section; 0 for none.
    u32 entry_rva = 0;
    // The module's boot entry (its lucent_boot), in an executable section; 0 for none. The loader
    // runs the entry point, then starts this with the boot_info.
    u32 boot_rva = 0;
    // The kit::boot_info version the module expects its host to hand it.
    u32 boot_info_version = 0;
    // The exception directory: 12-byte RUNTIME_FUNCTION entries inside one read-only section;
    // both 0 for none.
    u32 pdata_rva = 0;
    u32 pdata_size = 0;
    // Keys import_hash for this container's imports.
    import_key imports_key{};
    // Sorted by rva, non-overlapping, inside the image.
    std::vector<container_section> sections;
    // Slots holding an address as an offset from the image's base: the loader adds the base it
    // maps at. Ascending, 8 bytes apart at least, each inside a section.
    std::vector<u32> relocations;
    // Ascending by slot, 8 bytes apart at least, each slot inside a section.
    std::vector<container_import> imports;

    auto operator==(const container&) const -> bool = default;
};

// The first 8 bytes, little-endian, of BLAKE2b-256 keyed with the container's import key over the
// name: a module's file name in lowercase ASCII ("kernel32.dll"), an export's name as exported.
auto import_hash(const import_key& key, std::string_view name) -> u64;

// Whether the container follows every rule its members state: what the encoder requires and the
// decoder checks.
auto is_canonical(const container& image) -> bool;

// The decoded form, before compression. The container must be canonical, as its members say;
// anything else is our own bug.
auto encode_container_body(const container& image) -> std::vector<std::byte>;

// Canonical or nothing, as container's members describe, with nothing trailing.
auto decode_container_body(std::span<const std::byte> bytes) -> result<container>;

// The packed form the seal's digest covers: context, sizes, and the body as one LZ4 block,
// compressed at LZ4 HC's highest level.
auto pack_container(const container& image) -> std::vector<std::byte>;

// Decompresses and decodes. A body over 512 MiB, a block that doesn't decompress to exactly the
// stated size, or bytes trailing it are malformed; another version's context is
// version_mismatch.
auto unpack_container(std::span<const std::byte> packed) -> result<container>;

}
