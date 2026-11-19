#include <lucent/kit/feature_section.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/feature.hpp>
#include <lucent/kit/wiring.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

#include "feature_fixtures.hpp"

// The release manifest's features come from this section of the module file; a feature missing
// from it could never be granted by tag, and one listed with a wrong tag granted by the wrong one.

namespace lucent::kit {
namespace {

static_assert(feature_tag::is_feature_tag("visuals"));
static_assert(feature_tag::is_feature_tag("sound.v2"));
static_assert(!feature_tag::is_feature_tag(""));
static_assert(!feature_tag::is_feature_tag("Visuals"));
static_assert(!feature_tag::is_feature_tag("-visuals"));
static_assert(!feature_tag::is_feature_tag("visuals/esp"));

auto linked() -> std::vector<declared_feature> {
    // Wiring the fixtures is what places their records; the test binary's other tests wire them
    // too, so the records are there whichever test runs first.
    wiring features;
    features.add<fixtures::tracker>();
    features.add<fixtures::painter>();
    features.add<fixtures::listener>();
    const result<std::vector<declared_feature>> read = declared_features(linked_feature_section());
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

auto padded(std::string_view tag) -> std::array<char, max_feature_tag_size> {
    std::array<char, max_feature_tag_size> out{};
    std::ranges::copy(tag, out.begin());
    return out;
}

auto section_of(std::span<const feature_record> records) -> std::vector<std::byte> {
    std::vector<std::byte> bytes(sizeof(u64));
    bytes.append_range(std::as_bytes(records));
    return bytes;
}

TEST_CASE("every wired feature is in the feature section with its keyed id and its tag") {
    const std::vector<declared_feature> declared = linked();

    CHECK(
        std::ranges::contains(
            declared,
            declared_feature{.key = std::to_underlying(fixtures::tracker::id), .tag = "radar"}
        )
    );
    CHECK(
        std::ranges::contains(
            declared,
            declared_feature{.key = std::to_underlying(fixtures::painter::id), .tag = "visuals"}
        )
    );
    CHECK(
        std::ranges::contains(
            declared,
            declared_feature{.key = std::to_underlying(fixtures::listener::id), .tag = "sound.v2"}
        )
    );
}

TEST_CASE("the feature section reads the same from the module file as from the loaded image") {
    const std::vector<declared_feature> from_image = linked();
    const result<std::vector<std::byte>> file = os::read_file(own_path());
    REQUIRE(file.has_value());
    const result<pe::image_view> view = pe::image_view::parse(*file, pe::layout::file);
    REQUIRE(view.has_value());
    const auto section = std::ranges::find(view->sections(), ".lfeat", &pe::section::name);
    REQUIRE(section != view->sections().end());
    const result<std::span<const std::byte>> bytes = view->contents_of(*section);
    REQUIRE(bytes.has_value());

    const result<std::vector<declared_feature>> from_file = declared_features(*bytes);

    REQUIRE(from_file.has_value());
    CHECK(*from_file == from_image);
}

TEST_CASE("the feature section reader skips zeroed gaps and refuses a tag that isn't one") {
    const std::array good{
        feature_record{.key = 0x1111, .tag = padded("aim")},
        feature_record{.key = 0, .tag = {}},
        feature_record{.key = 0x2222, .tag = padded("visuals")},
    };
    std::array<char, max_feature_tag_size> unpadded = padded("aim");
    unpadded.back() = 'x';
    const std::array bad_padding{feature_record{.key = 0x1111, .tag = unpadded}};
    const std::array bad_tag{feature_record{.key = 0x1111, .tag = padded("Aim")}};
    std::vector<std::byte> cut = section_of(good);
    cut.resize(cut.size() - 8);

    const result<std::vector<declared_feature>> read = declared_features(section_of(good));

    REQUIRE(read.has_value());
    CHECK(
        *read
        == std::vector{
            declared_feature{.key = 0x1111, .tag = "aim"},
            declared_feature{.key = 0x2222, .tag = "visuals"},
        }
    );
    CHECK_FALSE(declared_features(section_of(bad_padding)).has_value());
    CHECK_FALSE(declared_features(section_of(bad_tag)).has_value());
    CHECK_FALSE(declared_features(cut).has_value());
}

}
}
