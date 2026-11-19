#include "image/raw_headers.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <span>
#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::pack {
namespace {

// build: the PE32+ layout (Microsoft's PE format documentation), unchanged since Windows NT
// found: the e_lfanew, file header and optional header offsets every PE reader uses
// breaks: the packer would read the wrong directory or flag; image_view already parsed these
//         headers, so a wrong offset here reads valid but unrelated bytes
constexpr usize lfanew_at = 0x3c;
constexpr usize file_header_after_signature = 4;
constexpr usize size_of_optional_header_at = 16;
constexpr usize optional_header_after_signature = 24;
constexpr usize number_of_directories_at = 108;
constexpr usize directories_at = 112;
constexpr usize section_header_size = 40;
constexpr usize characteristics_at = 36;

auto read_u32(std::span<const std::byte> bytes, usize offset) -> result<u32> {
    if (offset > bytes.size() || bytes.size() - offset < sizeof(u32)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    std::array<std::byte, sizeof(u32)> raw{};
    std::ranges::copy(bytes.subspan(offset, sizeof(u32)), raw.begin());
    return std::bit_cast<u32>(raw);
}

auto read_u16(std::span<const std::byte> bytes, usize offset) -> result<u16> {
    return read_u32(bytes, offset).transform([](u32 value) {
        return static_cast<u16>(value & 0xffffU);
    });
}

auto optional_header_offset(std::span<const std::byte> headers) -> result<usize> {
    return usize{LUCENT_TRY(read_u32(headers, lfanew_at))} + optional_header_after_signature;
}

}

auto raw_directory(const pe::image_view& image, u32 index) -> std::optional<pe::directory> {
    const std::span<const std::byte> headers = image.headers();
    const result<usize> optional = optional_header_offset(headers);
    if (!optional) {
        return std::nullopt;
    }
    const result<u32> count = read_u32(headers, *optional + number_of_directories_at);
    if (!count || index >= *count) {
        return std::nullopt;
    }
    const usize entry = *optional + directories_at + (usize{index} * 8);
    const result<u32> rva = read_u32(headers, entry);
    const result<u32> size = read_u32(headers, entry + 4);
    if (!rva || !size || *rva == 0 || *size == 0) {
        return std::nullopt;
    }
    return pe::directory{.rva = *rva, .size = *size};
}

auto section_characteristics(const pe::image_view& image) -> result<std::vector<u32>> {
    const std::span<const std::byte> headers = image.headers();
    const usize file_header =
        usize{LUCENT_TRY(read_u32(headers, lfanew_at))} + file_header_after_signature;
    const u16 optional_size =
        LUCENT_TRY(read_u16(headers, file_header + size_of_optional_header_at));
    const usize table = LUCENT_TRY(optional_header_offset(headers)) + optional_size;
    std::vector<u32> flags;
    for (usize index = 0; index < image.sections().size(); ++index) {
        const usize offset = table + (index * section_header_size) + characteristics_at;
        const u32 characteristics = LUCENT_TRY(read_u32(headers, offset));
        flags.push_back(characteristics);
    }
    return flags;
}

}
