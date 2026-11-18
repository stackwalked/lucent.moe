#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <random>
#include <ranges>
#include <span>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>
#include <catch2/generators/catch_generators.hpp>

#include <lucent/os/file.hpp>
#include <lucent/pe/exports.hpp>
#include <lucent/pe/image_view.hpp>
#include <lucent/pe/imports.hpp>
#include <lucent/pe/relocations.hpp>
#include <lucent/pe/tls.hpp>

#include "images.hpp"

namespace lucent::pe {
namespace {

constexpr error malformed{.code = error_code::malformed};
constexpr error unsupported{.code = error_code::unsupported};

auto own_file() -> std::vector<std::byte> {
    return required(os::read_file(own_path()));
}

auto read_u32(std::span<const std::byte> bytes, usize offset) -> u32 {
    std::array<std::byte, sizeof(u32)> raw{};
    std::ranges::copy(bytes.subspan(offset, sizeof(u32)), raw.begin());
    return std::bit_cast<u32>(raw);
}

auto write_u16(std::span<std::byte> bytes, usize offset, u16 value) -> void {
    std::ranges::copy(
        std::bit_cast<std::array<std::byte, sizeof(u16)>>(value), bytes.subspan(offset).begin()
    );
}

auto write_u32(std::span<std::byte> bytes, usize offset, u32 value) -> void {
    std::ranges::copy(
        std::bit_cast<std::array<std::byte, sizeof(u32)>>(value), bytes.subspan(offset).begin()
    );
}

// Where the PE signature starts: the DOS header's e_lfanew field.
auto nt_offset_of(std::span<const std::byte> bytes) -> usize {
    return read_u32(bytes, 0x3c);
}

}

TEST_CASE("input too short for a DOS header is malformed") {
    const std::vector<std::byte> bytes =
        GENERATE(std::vector<std::byte>{}, std::vector<std::byte>(2), std::vector<std::byte>(0x3d));
    CHECK(image_view::parse(bytes, layout::file) == std::unexpected(malformed));
}

TEST_CASE("a wrong DOS magic, a wrong PE signature or an out-of-range header offset is malformed") {
    std::vector<std::byte> bytes = own_file();
    const usize nt_offset = nt_offset_of(bytes);
    SECTION("DOS magic") {
        write_u16(bytes, 0, 0x4d5a);
    }
    SECTION("PE signature") {
        write_u32(bytes, nt_offset, 0x0000'4551);
    }
    SECTION("header offset") {
        write_u32(bytes, 0x3c, 0xffff'fff0);
    }
    CHECK(image_view::parse(bytes, layout::file) == std::unexpected(malformed));
}

TEST_CASE("another machine or a 32-bit optional header is unsupported") {
    std::vector<std::byte> bytes = own_file();
    const usize nt_offset = nt_offset_of(bytes);
    SECTION("i386 machine") {
        write_u16(bytes, nt_offset + 4, 0x014c);
    }
    SECTION("PE32 optional header") {
        write_u16(bytes, nt_offset + 24, 0x010b);
    }
    CHECK(image_view::parse(bytes, layout::file) == std::unexpected(unsupported));
}

TEST_CASE("a section count above the format's limit is malformed") {
    std::vector<std::byte> bytes = own_file();
    write_u16(bytes, nt_offset_of(bytes) + 6, 0xffff);
    CHECK(image_view::parse(bytes, layout::file) == std::unexpected(malformed));
}

TEST_CASE("an image cut short still parses its headers but fails on the tables it lost") {
    std::vector<std::byte> bytes = own_file();
    bytes.resize(0x1000);
    const image_view image = required(image_view::parse(bytes, layout::file));
    CHECK(imports_of(image) == std::unexpected(malformed));
}

TEST_CASE("corrupted images fail cleanly, never by reading outside the input") {
    const std::vector<std::byte> clean = own_file();
    std::uniform_int_distribution<usize> header_offset{0, 0xfff};
    std::uniform_int_distribution<usize> any_offset{0, clean.size() - 1};
    std::uniform_int_distribution<u32> any_byte{0, 255};
    std::uniform_int_distribution<i32> flips{1, 8};

    for (const u32 round : std::views::iota(u32{0}, u32{400})) {
        // Seeded per round, so a failing round reproduces on its own.
        // NOLINTNEXTLINE(bugprone-random-generator-seed): a fixed seed is the point.
        std::mt19937 random{20'261'117U + round};
        std::vector<std::byte> bytes = clean;
        for (const i32 flip : std::views::iota(0, flips(random))) {
            const usize offset = flip % 2 == 0 ? header_offset(random) : any_offset(random);
            bytes.at(offset) = static_cast<std::byte>(any_byte(random));
        }
        const result<image_view> parsed = image_view::parse(bytes, layout::file);
        if (!parsed) {
            continue;
        }
        // Any outcome is fine; reading past the input or tripping an invariant is not.
        std::ignore = relocations_of(*parsed);
        std::ignore = imports_of(*parsed);
        std::ignore = export_table::from_image(*parsed);
        std::ignore = tls_of(*parsed);
        for (const section& stored : parsed->sections()) {
            std::ignore = parsed->contents_of(stored);
        }
    }
}

}
