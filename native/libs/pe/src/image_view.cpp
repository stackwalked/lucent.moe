#include <lucent/pe/image_view.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>

#include "format.hpp"

namespace lucent::pe {

auto mapped_size_of(const section& stored) -> u32 {
    return stored.virtual_size == 0 ? stored.raw_size : stored.virtual_size;
}

namespace {

static_assert(sizeof(directory) == 8, "directory mirrors IMAGE_DATA_DIRECTORY");

constexpr error unsupported{.code = error_code::unsupported};
constexpr u32 max_string_size = 1024;

// SizeOfImage is what to_mapped_layout allocates, so a header alone must not be able to ask for
// 4 GiB. Real images claim no address space past their headers and sections, and stay far below
// this cap; together they bound the allocation by what the sections declare, and that by the cap.
// build: every x64 PE under System32, Program Files and the cs2 install, 10,363 images (2026-11-18)
// found: SizeOfImage equals the headers' and sections' end aligned to SectionAlignment in every
//        one; SectionAlignment is always a power of two; the largest is 335 MiB (msedge.dll)
// breaks: an image with slack past its last section, or over 1 GiB, fails to parse as malformed
constexpr u32 max_size_of_image = u32{1} << 30U;

// How much of that the file actually stores; the rest is zero-filled by a loader.
auto stored_size_of(const section& stored) -> u32 {
    return std::min(stored.raw_size, mapped_size_of(stored));
}

auto section_from(const detail::raw_section_header& raw) -> section {
    const auto name_end = std::ranges::find(raw.name, '\0');
    return section{
        .name = std::string{raw.name.begin(), name_end},
        .virtual_address = raw.virtual_address,
        .virtual_size = raw.virtual_size,
        .raw_offset = raw.raw_offset,
        .raw_size = raw.raw_size,
        .access = section_access{
            .is_readable = (raw.characteristics & detail::section_readable) != 0,
            .is_writable = (raw.characteristics & detail::section_writable) != 0,
            .is_executable = (raw.characteristics & detail::section_executable) != 0,
        },
    };
}

// The fixed-size headers, found and identified as PE32+ for x64.
struct nt_headers {
    detail::raw_file_header file;
    detail::raw_optional_header optional;
    usize optional_offset = 0;
};

auto read_nt_headers(std::span<const std::byte> bytes) -> result<nt_headers> {
    if (LUCENT_TRY(detail::read_at<u16>(bytes, 0)) != detail::dos_magic) {
        return std::unexpected(detail::malformed);
    }
    const u32 nt_offset = LUCENT_TRY(detail::read_at<u32>(bytes, detail::new_header_offset_field));
    if (LUCENT_TRY(detail::read_at<u32>(bytes, nt_offset)) != detail::nt_signature) {
        return std::unexpected(detail::malformed);
    }
    const usize file_offset = usize{nt_offset} + sizeof(u32);
    const auto file = LUCENT_TRY(detail::read_at<detail::raw_file_header>(bytes, file_offset));
    if (file.machine != detail::machine_amd64) {
        return std::unexpected(unsupported);
    }
    const usize optional_offset = file_offset + sizeof(detail::raw_file_header);
    const auto optional =
        LUCENT_TRY(detail::read_at<detail::raw_optional_header>(bytes, optional_offset));
    if (optional.magic != detail::optional_magic_pe32_plus) {
        return std::unexpected(unsupported);
    }
    return nt_headers{.file = file, .optional = optional, .optional_offset = optional_offset};
}

auto directory_count_of(const nt_headers& headers) -> usize {
    return std::min<usize>(headers.optional.directory_count, detail::max_directories);
}

auto is_consistent(const nt_headers& headers, usize byte_count) -> bool {
    const usize optional_size =
        sizeof(detail::raw_optional_header) + (directory_count_of(headers) * sizeof(directory));
    return headers.file.optional_header_size >= optional_size
           && headers.file.section_count <= detail::max_sections
           && std::has_single_bit(headers.optional.section_alignment)
           && headers.optional.size_of_image <= max_size_of_image
           && headers.optional.size_of_headers <= headers.optional.size_of_image
           && headers.optional.size_of_headers <= byte_count
           && headers.optional.entry_point < headers.optional.size_of_image;
}

auto read_directories(std::span<const std::byte> bytes, const nt_headers& headers)
    -> result<std::array<directory, detail::max_directories>> {
    std::array<directory, detail::max_directories> directories{};
    const usize first = headers.optional_offset + sizeof(detail::raw_optional_header);
    for (auto&& [index, slot] :
        std::views::enumerate(directories) | std::views::take(directory_count_of(headers))) {
        slot = LUCENT_TRY(
            detail::read_at<directory>(bytes, first + (narrow<usize>(index) * sizeof(directory)))
        );
    }
    return directories;
}

auto read_sections(std::span<const std::byte> bytes, const nt_headers& headers)
    -> result<std::vector<section>> {
    std::vector<section> sections;
    const usize first = headers.optional_offset + headers.file.optional_header_size;
    for (const u16 index : std::views::iota(u16{0}, headers.file.section_count)) {
        const usize offset = first + (usize{index} * sizeof(detail::raw_section_header));
        const auto raw = LUCENT_TRY(detail::read_at<detail::raw_section_header>(bytes, offset));
        const section stored = section_from(raw);
        if (u64{stored.virtual_address} + mapped_size_of(stored) > headers.optional.size_of_image) {
            return std::unexpected(detail::malformed);
        }
        sections.push_back(stored);
    }
    return sections;
}

// The address space the headers and sections claim, rounded up as a loader maps it.
auto claimed_size_of(const nt_headers& headers, std::span<const section> sections) -> u64 {
    const auto end_of = [](const section& stored) {
        return u64{stored.virtual_address} + mapped_size_of(stored);
    };
    const auto later = [](u64 left, u64 right) { return std::max(left, right); };
    const u64 end = std::ranges::fold_left(
        sections | std::views::transform(end_of), u64{headers.optional.size_of_headers}, later
    );
    const u64 alignment = headers.optional.section_alignment;
    return (end + alignment - 1) / alignment * alignment;
}

}

auto image_view::parse(std::span<const std::byte> bytes, layout arrangement) -> result<image_view> {
    const nt_headers headers = LUCENT_TRY(read_nt_headers(bytes));
    if (!is_consistent(headers, bytes.size())) {
        return std::unexpected(detail::malformed);
    }
    image_view image;
    image.m_bytes = bytes;
    image.m_layout = arrangement;
    image.m_image_base = headers.optional.image_base;
    image.m_size_of_image = headers.optional.size_of_image;
    image.m_size_of_headers = headers.optional.size_of_headers;
    image.m_entry_point = headers.optional.entry_point;
    image.m_directories = LUCENT_TRY(read_directories(bytes, headers));
    image.m_sections = LUCENT_TRY(read_sections(bytes, headers));
    if (headers.optional.size_of_image > claimed_size_of(headers, image.m_sections)) {
        return std::unexpected(detail::malformed);
    }
    return image;
}

auto image_view::image_base() const -> u64 {
    return m_image_base;
}

auto image_view::size_of_image() const -> u32 {
    return m_size_of_image;
}

auto image_view::size_of_headers() const -> u32 {
    return m_size_of_headers;
}

auto image_view::entry_point() const -> u32 {
    return m_entry_point;
}

auto image_view::sections() const -> std::span<const section> {
    return m_sections;
}

auto image_view::find_directory(directory_kind kind) const -> std::optional<directory> {
    const directory found = m_directories.at(std::to_underlying(kind));
    if (found.rva == 0 || found.size == 0) {
        return std::nullopt;
    }
    return found;
}

auto image_view::headers() const -> std::span<const std::byte> {
    return m_bytes.first(m_size_of_headers);
}

auto image_view::contents_of(const section& stored) const -> result<std::span<const std::byte>> {
    const u64 offset = m_layout == layout::file ? stored.raw_offset : stored.virtual_address;
    const u64 size = m_layout == layout::file ? stored_size_of(stored) : mapped_size_of(stored);
    if (offset + size > m_bytes.size()) {
        return std::unexpected(detail::malformed);
    }
    return m_bytes.subspan(narrow<usize>(offset), narrow<usize>(size));
}

auto image_view::bytes_at(rva_range range) const -> result<std::span<const std::byte>> {
    if (u64{range.rva} + range.size > m_size_of_image) {
        return std::unexpected(detail::malformed);
    }
    if (m_layout == layout::mapped || u64{range.rva} + range.size <= m_size_of_headers) {
        if (u64{range.rva} + range.size > m_bytes.size()) {
            return std::unexpected(detail::malformed);
        }
        return m_bytes.subspan(range.rva, range.size);
    }
    for (const section& stored : m_sections) {
        const u64 start = stored.virtual_address;
        const bool is_inside =
            range.rva >= start && u64{range.rva} + range.size <= start + stored_size_of(stored);
        if (is_inside) {
            const u64 offset = u64{stored.raw_offset} + (range.rva - start);
            if (offset + range.size > m_bytes.size()) {
                return std::unexpected(detail::malformed);
            }
            return m_bytes.subspan(narrow<usize>(offset), range.size);
        }
    }
    return std::unexpected(detail::malformed);
}

auto image_view::string_at(u32 rva) const -> result<std::string> {
    for (const u32 size : std::views::iota(u32{1}, max_string_size + 1)) {
        const std::span<const std::byte> bytes = LUCENT_TRY(bytes_at({.rva = rva, .size = size}));
        if (bytes.back() == std::byte{0}) {
            return bytes.first(size - 1) | std::views::transform([](std::byte byte) {
                return std::to_integer<char>(byte);
            }) | std::ranges::to<std::string>();
        }
    }
    return std::unexpected(detail::malformed);
}

auto to_mapped_layout(const image_view& image) -> result<std::vector<std::byte>> {
    std::vector<std::byte> mapped(image.size_of_image());
    std::ranges::copy(image.headers(), mapped.begin());
    for (const section& stored : image.sections()) {
        const std::span<const std::byte> contents = LUCENT_TRY(image.contents_of(stored));
        std::ranges::copy(contents, mapped.begin() + stored.virtual_address);
    }
    return mapped;
}

}
