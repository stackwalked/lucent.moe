#pragma once

#include <array>
#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace lucent::pe {

// How the bytes are laid out: as the file on disk, or as an image mapped by a loader (every
// address an offset from the first byte).
enum class layout : u8 { file, mapped };

// The data directories the mapper and its tools read. The values are the directories' indices.
enum class directory_kind : u8 {
    exports = 0,
    imports = 1,
    exceptions = 3,
    base_relocations = 5,
    tls = 9,
    load_config = 10,
};

struct directory {
    u32 rva = 0;
    u32 size = 0;

    auto operator==(const directory&) const -> bool = default;
};

// An address range in the image, relative to its base.
struct rva_range {
    u32 rva = 0;
    u32 size = 0;
};

struct section_access {
    bool is_readable = false;
    bool is_writable = false;
    bool is_executable = false;
};

struct section {
    std::string name;
    u32 virtual_address = 0;
    u32 virtual_size = 0;
    u32 raw_offset = 0;
    u32 raw_size = 0;
    section_access access;
};

// How much address space the section takes once mapped: its virtual size, or its raw size when the
// linker left the virtual size at zero.
auto mapped_size_of(const section& stored) -> u32;

// A PE32+ (x64) image. Everything it returns is copied out and bounds-checked: input that doesn't
// form a valid image fails as error_code::malformed, other machines as unsupported.
// The bytes must outlive the view.
class image_view final {
public:
    static auto parse(std::span<const std::byte> bytes, layout arrangement) -> result<image_view>;

    auto image_base() const -> u64;
    auto size_of_image() const -> u32;
    auto size_of_headers() const -> u32;
    // An offset from the base; 0 when the image has no entry point.
    auto entry_point() const -> u32;
    auto sections() const -> std::span<const section>;
    // Absent when the image doesn't have that directory.
    auto find_directory(directory_kind kind) const -> std::optional<directory>;

    // The headers as stored; a loader copies them to the image's base.
    auto headers() const -> std::span<const std::byte>;
    // A section's bytes as stored: its raw data in a file, its virtual range in a mapped image.
    auto contents_of(const section& stored) const -> result<std::span<const std::byte>>;
    auto bytes_at(rva_range range) const -> result<std::span<const std::byte>>;
    // A NUL-terminated string, at most 1 KiB, as names in the image are.
    auto string_at(u32 rva) const -> result<std::string>;

private:
    image_view() = default;

    std::span<const std::byte> m_bytes;
    layout m_layout = layout::file;
    u64 m_image_base = 0;
    u32 m_size_of_image = 0;
    u32 m_size_of_headers = 0;
    u32 m_entry_point = 0;
    std::vector<section> m_sections;
    std::array<directory, 16> m_directories{};
};

}
