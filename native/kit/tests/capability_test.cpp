#include <lucent/kit/capability.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

#include "fact_fixtures.hpp"

namespace lucent::kit {
namespace {

static_assert(capability_key("entities") != fact_key(dev_fact_seed, "entities"));
static_assert(sizeof(capability_record<fixtures::shared>) == 24);

auto linked() -> std::vector<declared_capability> {
    const result<std::vector<declared_capability>> read =
        declared_capabilities(linked_capability_section());
    REQUIRE(read.has_value());
    return *read;
}

auto own_path() -> std::filesystem::path {
    std::wstring path(32'768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(std::ssize(path)));
    REQUIRE(length > 0);
    path.resize(length);
    return path;
}

// The second header word: the level in its low byte, the member count in its high half.
constexpr auto level_and_count(u8 level, u32 count) -> u64 {
    return u64{level} | (u64{count} << 32U);
}

TEST_CASE(
    "a capability declared in a header two units include folds to one record in the section"
) {
    const std::vector<declared_capability> declared = linked();
    const u64 key = capability_key("shared_capability");

    CHECK(std::ranges::count(declared, key, &declared_capability::key) == 1);
    CHECK(fixtures::other_unit_shared_capability() == &fixtures::shared_capability);
    const auto found = std::ranges::find(declared, key, &declared_capability::key);
    REQUIRE(found != declared.end());
    CHECK(found->level == capability_level::core);
    CHECK(found->members == std::vector{fixtures::shared_value.record().key});
    CHECK(
        std::ranges::contains(
            declared, capability_key("other_unit_capability"), &declared_capability::key
        )
    );
}

TEST_CASE("the capability section reads the same from the module file as from the loaded image") {
    const result<std::vector<std::byte>> file = os::read_file(own_path());
    REQUIRE(file.has_value());
    const result<pe::image_view> view = pe::image_view::parse(*file, pe::layout::file);
    REQUIRE(view.has_value());
    const auto section = std::ranges::find(view->sections(), ".lcap", &pe::section::name);
    REQUIRE(section != view->sections().end());
    const result<std::span<const std::byte>> bytes = view->contents_of(*section);
    REQUIRE(bytes.has_value());

    const result<std::vector<declared_capability>> from_file = declared_capabilities(*bytes);

    REQUIRE(from_file.has_value());
    CHECK(*from_file == linked());
}

TEST_CASE("the section reader skips zeroed gaps between records") {
    // Each record is its key, level and count, then one member key.
    const std::array<u64, 8> section{
        0,
        0x1111,
        level_and_count(1, 1),
        0xaaaa,
        0,
        0x2222,
        level_and_count(0, 1),
        0xbbbb,
    };

    const result<std::vector<declared_capability>> read =
        declared_capabilities(std::as_bytes(std::span{section}));

    REQUIRE(read.has_value());
    CHECK(
        *read
        == std::vector{
            declared_capability{
                .key = 0x1111, .level = capability_level::core, .members = {0xaaaa}
            },
            declared_capability{
                .key = 0x2222,
                .level = capability_level::optional,
                .members = {0xbbbb},
            },
        }
    );
}

TEST_CASE("the section reader refuses a record cut short, an unknown level, or no members") {
    const std::array<u64, 3> cut_short{0x1111, level_and_count(0, 2), 0xaaaa};
    const std::array<u64, 3> unknown_level{0x1111, level_and_count(2, 1), 0xaaaa};
    const std::array<u64, 2> no_members{0x1111, level_and_count(0, 0)};
    const std::array<u64, 3> zero_member{0x1111, level_and_count(0, 1), 0};

    CHECK_FALSE(declared_capabilities(std::as_bytes(std::span{cut_short})).has_value());
    CHECK_FALSE(declared_capabilities(std::as_bytes(std::span{unknown_level})).has_value());
    CHECK_FALSE(declared_capabilities(std::as_bytes(std::span{no_members})).has_value());
    CHECK_FALSE(declared_capabilities(std::as_bytes(std::span{zero_member})).has_value());
}

}
}
