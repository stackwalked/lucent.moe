#include <lucent/wire/container.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <lz4.h>
#include <lz4hc.h>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>

#include "codec.hpp"

// Version 1:
//   packed: context "lucent container v1" (32), u32 body size, u32 block size, the body as one
//     LZ4 block of exactly block size bytes.
//   body: release id (16), u32 image size, u32 entry rva, u32 boot rva, u32 boot_info version,
//     u32 pdata rva, u32 pdata size, import key (32), u32 section count, u32 relocation count,
//     u32 import count;
//     per section: u32 rva, u32 mapped size, u32 stored size, u8 access; per relocation: u32 slot
//     rva; per import: u64 module hash, u64 function hash, u32 slot rva; then every section's
//     stored bytes, in section order.

namespace lucent::wire {
namespace {

constexpr u32 version = 1;
constexpr u32 max_body_size = u32{512} << 20U;
constexpr usize section_entry_size = 13;
constexpr usize relocation_entry_size = 4;
constexpr usize import_entry_size = 20;
constexpr u32 runtime_function_size = 12;
constexpr u32 slot_size = 8;

auto is_page_aligned(u32 value) -> bool {
    return value % container_page_size == 0;
}

auto is_known(section_access access) -> bool {
    switch (access) {
    case section_access::read:
    case section_access::read_write:
    case section_access::read_execute:
        return true;
    }
    return false;
}

auto is_canonical_data(const container_section& section) -> bool {
    const usize stored = section.data.size();
    if (stored % container_page_size != 0 || stored > section.mapped_size) {
        return false;
    }
    if (stored == 0) {
        return true;
    }
    const std::span<const std::byte> last_page = std::span{section.data}.last(container_page_size);
    return std::ranges::any_of(last_page, [](std::byte each) { return each != std::byte{0}; });
}

auto is_canonical_layout(const container& image) -> bool {
    u64 end = 0;
    for (const container_section& section : image.sections) {
        const u64 section_end = u64{section.rva} + section.mapped_size;
        if (!is_page_aligned(section.rva)
            || !is_page_aligned(section.mapped_size)
            || section.mapped_size == 0
            || section.rva < end
            || section_end > image.image_size
            || !is_known(section.access)
            || !is_canonical_data(section)) {
            return false;
        }
        end = section_end;
    }
    return true;
}

auto section_holding(const container& image, u32 rva, u32 size) -> const container_section* {
    for (const container_section& section : image.sections) {
        if (rva >= section.rva && u64{rva} + size <= u64{section.rva} + section.mapped_size) {
            return &section;
        }
    }
    return nullptr;
}

// Ascending, each slot clear of the one before it, each inside a section.
auto are_canonical_slots(const container& image, std::span<const u32> slots) -> bool {
    std::optional<u32> previous;
    for (const u32 slot : slots) {
        if (previous && u64{slot} < u64{*previous} + slot_size) {
            return false;
        }
        if (section_holding(image, slot, slot_size) == nullptr) {
            return false;
        }
        previous = slot;
    }
    return true;
}

auto import_slots(const container& image) -> std::vector<u32> {
    std::vector<u32> slots;
    slots.reserve(image.imports.size());
    for (const container_import& each : image.imports) {
        slots.push_back(each.slot_rva);
    }
    return slots;
}

// 0, or inside an executable section.
auto is_canonical_code_rva(const container& image, u32 rva) -> bool {
    if (rva == 0) {
        return true;
    }
    const container_section* holder = section_holding(image, rva, 1);
    return holder != nullptr && holder->access == section_access::read_execute;
}

auto is_canonical_pdata(const container& image) -> bool {
    if (image.pdata_rva == 0 && image.pdata_size == 0) {
        return true;
    }
    if (image.pdata_size == 0 || image.pdata_size % runtime_function_size != 0) {
        return false;
    }
    const container_section* holder = section_holding(image, image.pdata_rva, image.pdata_size);
    return holder != nullptr && holder->access == section_access::read;
}

auto read_counted(detail::reader& input, usize entry_size) -> result<u32> {
    const u32 count = LUCENT_TRY(input.read_u32());
    if (u64{count} * entry_size > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    return count;
}

struct section_entry {
    u32 rva = 0;
    u32 mapped_size = 0;
    u32 stored_size = 0;
    u8 access = 0;
};

auto access_of(u8 code) -> result<section_access> {
    switch (code) {
    case std::to_underlying(section_access::read):
        return section_access::read;
    case std::to_underlying(section_access::read_write):
        return section_access::read_write;
    case std::to_underlying(section_access::read_execute):
        return section_access::read_execute;
    default:
        return std::unexpected(detail::malformed);
    }
}

// Everything before the section entries.
auto read_header(detail::reader& input, container& image) -> result<void> {
    image.release.bytes = LUCENT_TRY(input.read_array<id_size>());
    image.image_size = LUCENT_TRY(input.read_u32());
    image.entry_rva = LUCENT_TRY(input.read_u32());
    image.boot_rva = LUCENT_TRY(input.read_u32());
    image.boot_info_version = LUCENT_TRY(input.read_u32());
    image.pdata_rva = LUCENT_TRY(input.read_u32());
    image.pdata_size = LUCENT_TRY(input.read_u32());
    image.imports_key = LUCENT_TRY(input.read_array<import_key_size>());
    return {};
}

auto read_relocations(detail::reader& input, u32 count) -> result<std::vector<u32>> {
    if (u64{count} * relocation_entry_size > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    std::vector<u32> slots;
    slots.reserve(count);
    for (u32 index = 0; index < count; ++index) {
        slots.push_back(LUCENT_TRY(input.read_u32()));
    }
    return slots;
}

auto read_imports(detail::reader& input, u32 count) -> result<std::vector<container_import>> {
    if (u64{count} * import_entry_size > input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    std::vector<container_import> imports;
    imports.reserve(count);
    for (u32 index = 0; index < count; ++index) {
        container_import each;
        each.module_hash = LUCENT_TRY(input.read_u64());
        each.function_hash = LUCENT_TRY(input.read_u64());
        each.slot_rva = LUCENT_TRY(input.read_u32());
        imports.push_back(each);
    }
    return imports;
}

auto read_section_data(detail::reader& input, const std::vector<section_entry>& entries)
    -> result<std::vector<container_section>> {
    std::vector<container_section> sections;
    sections.reserve(entries.size());
    for (const section_entry& entry : entries) {
        const section_access access = LUCENT_TRY(access_of(entry.access));
        const std::span<const std::byte> data = LUCENT_TRY(input.read_bytes(entry.stored_size));
        sections.push_back(
            container_section{
                .rva = entry.rva,
                .mapped_size = entry.mapped_size,
                .access = access,
                .data = {data.begin(), data.end()},
            }
        );
    }
    return sections;
}

// LZ4 speaks char; our bytes are std::byte. Same object representation.
auto as_chars(std::span<const std::byte> bytes) -> const char* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): std::byte and char share one object representation; LZ4 takes char.
    return reinterpret_cast<const char*>(bytes.data());
}

auto as_writable_chars(std::span<std::byte> bytes) -> char* {
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): as above.
    return reinterpret_cast<char*>(bytes.data());
}

auto read_sections(detail::reader& input, u32 count) -> result<std::vector<section_entry>> {
    std::vector<section_entry> entries;
    entries.reserve(count);
    for (u32 index = 0; index < count; ++index) {
        section_entry entry;
        entry.rva = LUCENT_TRY(input.read_u32());
        entry.mapped_size = LUCENT_TRY(input.read_u32());
        entry.stored_size = LUCENT_TRY(input.read_u32());
        entry.access = LUCENT_TRY(input.read_u8());
        entries.push_back(entry);
    }
    return entries;
}

}

auto is_canonical(const container& image) -> bool {
    return image.image_size != 0
           && is_page_aligned(image.image_size)
           && image.image_size <= max_container_image_size
           && is_canonical_layout(image)
           && is_canonical_code_rva(image, image.entry_rva)
           && is_canonical_code_rva(image, image.boot_rva)
           && is_canonical_pdata(image)
           && are_canonical_slots(image, image.relocations)
           && are_canonical_slots(image, import_slots(image));
}

auto import_hash(const import_key& key, std::string_view name) -> u64 {
    const crypto::digest digest = crypto::keyed_hash(key, std::as_bytes(std::span{name}));
    u64 value = 0;
    for (usize index = 0; index < sizeof(u64); ++index) {
        value |= static_cast<u64>(digest.at(index)) << (8U * index);
    }
    return value;
}

auto encode_container_body(const container& image) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(image));
    detail::writer out;
    out.write_bytes(image.release.bytes);
    out.write_u32(image.image_size);
    out.write_u32(image.entry_rva);
    out.write_u32(image.boot_rva);
    out.write_u32(image.boot_info_version);
    out.write_u32(image.pdata_rva);
    out.write_u32(image.pdata_size);
    out.write_bytes(image.imports_key);
    out.write_u32(narrow<u32>(image.sections.size()));
    out.write_u32(narrow<u32>(image.relocations.size()));
    out.write_u32(narrow<u32>(image.imports.size()));
    for (const container_section& section : image.sections) {
        out.write_u32(section.rva);
        out.write_u32(section.mapped_size);
        out.write_u32(narrow<u32>(section.data.size()));
        out.write_u8(std::to_underlying(section.access));
    }
    for (const u32 slot : image.relocations) {
        out.write_u32(slot);
    }
    for (const container_import& each : image.imports) {
        out.write_u64(each.module_hash);
        out.write_u64(each.function_hash);
        out.write_u32(each.slot_rva);
    }
    for (const container_section& section : image.sections) {
        out.write_bytes(section.data);
    }
    return out.take();
}

auto decode_container_body(std::span<const std::byte> bytes) -> result<container> {
    detail::reader input{bytes};
    container image;
    LUCENT_TRY(read_header(input, image));
    const u32 section_count = LUCENT_TRY(read_counted(input, section_entry_size));
    const u32 relocation_count = LUCENT_TRY(input.read_u32());
    const u32 import_count = LUCENT_TRY(input.read_u32());
    const std::vector<section_entry> entries = LUCENT_TRY(read_sections(input, section_count));
    image.relocations = LUCENT_TRY(read_relocations(input, relocation_count));
    image.imports = LUCENT_TRY(read_imports(input, import_count));
    image.sections = LUCENT_TRY(read_section_data(input, entries));
    if (!is_canonical(image)) {
        return std::unexpected(detail::malformed);
    }
    return detail::finish(input, std::move(image));
}

auto pack_container(const container& image) -> std::vector<std::byte> {
    const std::vector<std::byte> body = encode_container_body(image);
    LUCENT_INVARIANT(body.size() <= max_body_size);
    const i32 body_size = narrow<i32>(body.size());
    std::vector<std::byte> block(narrow<usize>(LZ4_compressBound(body_size)));
    const i32 block_size = LZ4_compress_HC(
        as_chars(body),
        as_writable_chars(block),
        body_size,
        narrow<i32>(block.size()),
        LZ4HC_CLEVEL_MAX
    );
    LUCENT_INVARIANT(block_size > 0);
    block.resize(narrow<usize>(block_size));
    detail::writer out;
    out.write_context("container", version);
    out.write_u32(narrow<u32>(body.size()));
    out.write_u32(narrow<u32>(block.size()));
    out.write_bytes(block);
    return out.take();
}

auto unpack_container(std::span<const std::byte> packed) -> result<container> {
    detail::reader input{packed};
    LUCENT_TRY(input.read_context("container", version));
    const u32 body_size = LUCENT_TRY(input.read_u32());
    const u32 block_size = LUCENT_TRY(input.read_u32());
    if (body_size > max_body_size || block_size == 0 || block_size != input.remaining()) {
        return std::unexpected(detail::malformed);
    }
    const std::span<const std::byte> block = LUCENT_TRY(input.read_bytes(block_size));
    // The decoded body is the module in plaintext: wiped when it goes, on every path.
    crypto::secret_bytes body = crypto::secret_bytes::zeroed(body_size);
    const i32 decompressed = LZ4_decompress_safe(
        as_chars(block),
        as_writable_chars(body.as_writable_bytes()),
        narrow<i32>(block.size()),
        narrow<i32>(body.as_bytes().size())
    );
    if (decompressed < 0 || narrow<u32>(decompressed) != body_size) {
        return std::unexpected(detail::malformed);
    }
    return decode_container_body(body.as_bytes());
}

}
