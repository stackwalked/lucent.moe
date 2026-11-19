#include "image/convert.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <format>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/pe/relocations.hpp>
#include <lucent/pe/tls.hpp>
#include <lucent/wire/container.hpp>

#include "image/raw_headers.hpp"
#include "image/refusal.hpp"
#include "image/system_modules.hpp"

namespace lucent::pack {
namespace {

// build: the PE32+ import and debug directory layouts (Microsoft's PE format documentation)
// found: IMAGE_IMPORT_DESCRIPTOR and IMAGE_DEBUG_DIRECTORY in winnt.h
// breaks: a name left in the container, or a scrub that zeroes the wrong bytes (the mapped
//         module then crashes on data it needed)
constexpr u32 import_descriptor_size = 20;
constexpr u32 descriptor_name_at = 12;
constexpr u32 descriptor_first_thunk_at = 16;
constexpr u32 debug_entry_size = 28;
constexpr u32 debug_data_size_at = 16;
constexpr u32 debug_data_rva_at = 20;
constexpr u64 ordinal_flag = u64{1} << 63U;
constexpr u32 hint_size = 2;

auto refuse(refusal_reason reason, std::string detail) -> std::unexpected<refusal> {
    return std::unexpected(refusal{.reason = reason, .detail = std::move(detail)});
}

auto from_pe(const error& failure) -> refusal {
    return refusal{
        .reason = refusal_reason::not_an_image,
        .detail = std::format(
            "the pe library refused it (error code {})", std::to_underlying(failure.code)
        ),
    };
}

auto align_up(u32 value) -> u32 {
    return (value + wire::container_page_size - 1) / wire::container_page_size
           * wire::container_page_size;
}

// The local image, by offset from its base, as the loader would see it before relocation.
class local_image final {
public:
    explicit local_image(std::vector<std::byte> bytes)
        : m_bytes{std::move(bytes)} {}

    auto read_u32(u32 rva) const -> std::optional<u32> {
        return read(rva, sizeof(u32)).transform([](u64 value) { return static_cast<u32>(value); });
    }

    auto read_u64(u32 rva) const -> std::optional<u64> {
        return read(rva, sizeof(u64));
    }

    auto write_u64(u32 rva, u64 value) -> void {
        LUCENT_INVARIANT(fits(rva, sizeof(u64)));
        std::ranges::copy(
            std::bit_cast<std::array<std::byte, sizeof(u64)>>(value),
            m_bytes.begin() + narrow<isize>(rva)
        );
    }

    // Bytes outside the image are left alone: the scrub only removes what is there.
    auto zero(u32 rva, u64 size) -> void {
        if (rva >= m_bytes.size()) {
            return;
        }
        const auto count = narrow<usize>(std::min<u64>(size, m_bytes.size() - rva));
        std::fill_n(m_bytes.begin() + narrow<isize>(rva), count, std::byte{0});
    }

    // A NUL-terminated name, its terminator included.
    auto zero_string(u32 rva) -> void {
        if (rva == 0 || rva >= m_bytes.size()) {
            return;
        }
        const auto start = m_bytes.begin() + narrow<isize>(rva);
        const auto end = std::find(start, m_bytes.end(), std::byte{0});
        std::fill(start, end == m_bytes.end() ? end : end + 1, std::byte{0});
    }

    auto bytes() const -> std::span<const std::byte> {
        return m_bytes;
    }

private:
    auto fits(u32 rva, usize size) const -> bool {
        return rva <= m_bytes.size() && m_bytes.size() - rva >= size;
    }

    // Little-endian, `size` bytes of at most 8.
    auto read(u32 rva, usize size) const -> std::optional<u64> {
        if (!fits(rva, size)) {
            return std::nullopt;
        }
        u64 value = 0;
        for (usize index = 0; index < size; ++index) {
            value |= static_cast<u64>(m_bytes.at(rva + index)) << (8U * index);
        }
        return value;
    }

    std::vector<std::byte> m_bytes;
};

// A lookup table's entries name hint/name entries; a slot table's entries do too until the loader
// binds them, but only an image without lookup tables reads them that way.
enum class thunk_table : u8 { lookup, slots };

// Zeroes a thunk table up to and including its terminator, and with it each hint/name entry it
// points at.
auto scrub_thunks(local_image& local, u32 table, thunk_table kind) -> void {
    for (u32 at = table; at != 0; at += sizeof(u64)) {
        const std::optional<u64> thunk = local.read_u64(at);
        if (!thunk) {
            return;
        }
        if (kind == thunk_table::lookup && *thunk != 0 && (*thunk & ordinal_flag) == 0) {
            const u32 hint_name = narrow<u32>(*thunk & 0x7fff'ffffU);
            local.zero(hint_name, hint_size);
            local.zero_string(hint_name + hint_size);
        }
        local.zero(at, sizeof(u64));
        if (*thunk == 0) {
            return;
        }
    }
}

auto scrub_imports(local_image& local, const pe::image_view& image) -> void {
    const std::optional<pe::directory> directory =
        image.find_directory(pe::directory_kind::imports);
    if (!directory) {
        return;
    }
    for (u32 at = directory->rva;; at += import_descriptor_size) {
        const std::optional<u32> lookup = local.read_u32(at);
        const std::optional<u32> name = local.read_u32(at + descriptor_name_at);
        const std::optional<u32> slots = local.read_u32(at + descriptor_first_thunk_at);
        if (!lookup || !name || !slots || (*lookup == 0 && *name == 0 && *slots == 0)) {
            break;
        }
        local.zero_string(*name);
        if (*lookup != 0) {
            scrub_thunks(local, *lookup, thunk_table::lookup);
        }
        scrub_thunks(local, *slots, *lookup == 0 ? thunk_table::lookup : thunk_table::slots);
    }
    local.zero(directory->rva, directory->size);
}

auto scrub_debug(local_image& local, const pe::image_view& image) -> void {
    const std::optional<pe::directory> directory = raw_directory(image, debug_directory);
    if (!directory) {
        return;
    }
    for (u32 offset = 0; offset + debug_entry_size <= directory->size; offset += debug_entry_size) {
        const std::optional<u32> size =
            local.read_u32(directory->rva + offset + debug_data_size_at);
        const std::optional<u32> rva = local.read_u32(directory->rva + offset + debug_data_rva_at);
        if (size && rva && *rva != 0) {
            local.zero(*rva, *size);
        }
    }
    local.zero(directory->rva, directory->size);
}

// lucent_boot's RVA, read before the export directory is scrubbed; 0 when the image doesn't
// export it and that is allowed.
auto boot_rva_of(const pe::image_view& image, boot_entry boot) -> pack_result<u32> {
    std::optional<u32> found;
    if (image.find_directory(pe::directory_kind::exports)) {
        const result<pe::export_table> exports = pe::export_table::from_image(image);
        if (!exports) {
            return std::unexpected(from_pe(exports.error()));
        }
        const result<pe::export_target> target = exports->find("lucent_boot");
        if (target) {
            found = match(
                *target,
                [](const pe::export_address& address) -> std::optional<u32> { return address.rva; },
                [](const pe::forwarder&) -> std::optional<u32> { return std::nullopt; }
            );
        }
    }
    if (found) {
        return *found;
    }
    switch (boot) {
    case boot_entry::optional:
        return 0;
    case boot_entry::required:
        return refuse(refusal_reason::missing_boot_entry, "lucent_boot");
    }
    LUCENT_UNREACHABLE();
}

auto scrub_exports(local_image& local, const pe::image_view& image) -> void {
    const std::optional<pe::directory> directory =
        image.find_directory(pe::directory_kind::exports);
    if (directory) {
        local.zero(directory->rva, directory->size);
    }
}

auto hashed_imports(const pe::image_view& image, const wire::import_key& key)
    -> pack_result<std::vector<wire::container_import>> {
    const result<std::vector<pe::import_module>> modules = pe::imports_of(image);
    if (!modules) {
        return std::unexpected(from_pe(modules.error()));
    }
    system_modules system;
    std::vector<wire::container_import> imports;
    for (const pe::import_module& module : *modules) {
        const std::string resolved = LUCENT_TRY(system.resolve_module(module.name));
        const u64 module_hash = wire::import_hash(key, resolved);
        for (const pe::import_entry& entry : module.entries) {
            const std::optional<std::string> name = match(
                entry.target,
                [](const pe::import_by_name& by_name) -> std::optional<std::string> {
                    return by_name.name;
                },
                [](pe::export_ordinal) -> std::optional<std::string> { return std::nullopt; }
            );
            if (!name) {
                return refuse(
                    refusal_reason::import_by_ordinal,
                    std::format("{} at slot {:#x}", module.name, entry.slot_rva)
                );
            }
            LUCENT_TRY(system.check_export(module.name, *name));
            imports.push_back(
                wire::container_import{
                    .module_hash = module_hash,
                    .function_hash = wire::import_hash(key, *name),
                    .slot_rva = entry.slot_rva,
                }
            );
        }
    }
    std::ranges::sort(imports, {}, &wire::container_import::slot_rva);
    return imports;
}

auto rebased_relocations(local_image& local, const pe::image_view& image)
    -> pack_result<std::vector<u32>> {
    const result<std::vector<u32>> slots = pe::relocations_of(image);
    if (!slots) {
        return std::unexpected(from_pe(slots.error()));
    }
    std::vector<u32> rebased = *slots;
    for (const u32 slot : rebased) {
        const std::optional<u64> address = local.read_u64(slot);
        if (!address
            || *address < image.image_base()
            || *address - image.image_base() >= image.size_of_image()) {
            return refuse(
                refusal_reason::relocation_outside_image, std::format("slot {:#x}", slot)
            );
        }
        local.write_u64(slot, *address - image.image_base());
    }
    std::ranges::sort(rebased);
    return rebased;
}

auto access_of(const pe::section& stored) -> pack_result<wire::section_access> {
    if (stored.access.is_executable && stored.access.is_writable) {
        return refuse(refusal_reason::writable_and_executable, stored.name);
    }
    if (stored.access.is_executable) {
        return wire::section_access::read_execute;
    }
    return stored.access.is_writable ? wire::section_access::read_write
                                     : wire::section_access::read;
}

// The section's bytes with trailing zero pages dropped.
auto stored_bytes(std::span<const std::byte> mapped) -> std::vector<std::byte> {
    usize size = mapped.size();
    while (size > 0) {
        const std::span<const std::byte> page =
            mapped.subspan(size - wire::container_page_size, wire::container_page_size);
        if (std::ranges::any_of(page, [](std::byte each) { return each != std::byte{0}; })) {
            break;
        }
        size -= wire::container_page_size;
    }
    return {mapped.begin(), mapped.begin() + narrow<isize>(size)};
}

auto kept_sections(const local_image& local, const pe::image_view& image)
    -> pack_result<std::vector<wire::container_section>> {
    const result<std::vector<u32>> characteristics = section_characteristics(image);
    if (!characteristics) {
        return std::unexpected(from_pe(characteristics.error()));
    }
    std::vector<wire::container_section> sections;
    for (const auto [index, stored] : std::views::enumerate(image.sections())) {
        const wire::section_access access = LUCENT_TRY(access_of(stored));
        if ((characteristics->at(narrow<usize>(index)) & discardable_flag) != 0) {
            continue;
        }
        const u32 mapped_size = align_up(pe::mapped_size_of(stored));
        if (stored.virtual_address % wire::container_page_size != 0
            || u64{stored.virtual_address} + mapped_size > local.bytes().size()) {
            return refuse(refusal_reason::misaligned_section, stored.name);
        }
        if (mapped_size == 0) {
            continue;
        }
        sections.push_back(
            wire::container_section{
                .rva = stored.virtual_address,
                .mapped_size = mapped_size,
                .access = access,
                .data = stored_bytes(local.bytes().subspan(stored.virtual_address, mapped_size)),
            }
        );
    }
    return sections;
}

auto is_kept(const std::vector<wire::container_section>& sections, u32 rva, u32 size) -> bool {
    return std::ranges::any_of(sections, [&](const wire::container_section& section) {
        return rva >= section.rva && u64{rva} + size <= u64{section.rva} + section.mapped_size;
    });
}

auto check_kept(const wire::container& image) -> pack_result<void> {
    for (const u32 slot : image.relocations) {
        if (!is_kept(image.sections, slot, sizeof(u64))) {
            return refuse(
                refusal_reason::outside_kept_sections, std::format("relocation {:#x}", slot)
            );
        }
    }
    for (const wire::container_import& each : image.imports) {
        if (!is_kept(image.sections, each.slot_rva, sizeof(u64))) {
            return refuse(
                refusal_reason::outside_kept_sections,
                std::format("import slot {:#x}", each.slot_rva)
            );
        }
    }
    if (image.pdata_size != 0 && !is_kept(image.sections, image.pdata_rva, image.pdata_size)) {
        return refuse(refusal_reason::outside_kept_sections, ".pdata");
    }
    if (image.boot_rva != 0 && !is_kept(image.sections, image.boot_rva, 1)) {
        return refuse(refusal_reason::outside_kept_sections, "the boot entry");
    }
    if (image.entry_rva != 0 && !is_kept(image.sections, image.entry_rva, 1)) {
        return refuse(refusal_reason::outside_kept_sections, "the entry point");
    }
    return {};
}

}

auto container_from_image(std::span<const std::byte> file, const container_identity& identity)
    -> pack_result<wire::container> {
    const result<pe::image_view> parsed = pe::image_view::parse(file, pe::layout::file);
    if (!parsed) {
        return std::unexpected(from_pe(parsed.error()));
    }
    const pe::image_view& image = *parsed;
    const result<std::optional<pe::tls_info>> tls = pe::tls_of(image);
    if (!tls || tls->has_value()) {
        return refuse(refusal_reason::tls_directory, "the TLS directory");
    }
    if (raw_directory(image, delay_import_directory)) {
        return refuse(refusal_reason::delay_imports, "the delay-load import directory");
    }
    result<std::vector<std::byte>> mapped = pe::to_mapped_layout(image);
    if (!mapped) {
        return std::unexpected(from_pe(mapped.error()));
    }
    local_image local{std::move(*mapped)};

    std::vector<wire::container_import> imports =
        LUCENT_TRY(hashed_imports(image, identity.imports_key));
    std::vector<u32> relocations = LUCENT_TRY(rebased_relocations(local, image));
    scrub_imports(local, image);
    scrub_debug(local, image);
    const u32 boot_rva = LUCENT_TRY(boot_rva_of(image, identity.boot));
    scrub_exports(local, image);

    const std::optional<pe::directory> pdata = image.find_directory(pe::directory_kind::exceptions);
    wire::container out{
        .release = identity.release,
        .image_size = align_up(image.size_of_image()),
        .entry_rva = image.entry_point(),
        .boot_rva = boot_rva,
        .boot_info_version = identity.boot_info_version,
        .pdata_rva = pdata ? pdata->rva : 0,
        .pdata_size = pdata ? pdata->size : 0,
        .imports_key = identity.imports_key,
        .sections = LUCENT_TRY(kept_sections(local, image)),
        .relocations = std::move(relocations),
        .imports = std::move(imports),
    };
    LUCENT_TRY(check_kept(out));
    if (!wire::is_canonical(out)) {
        return refuse(refusal_reason::not_canonical, "wire::is_canonical refused the result");
    }
    return out;
}

}
