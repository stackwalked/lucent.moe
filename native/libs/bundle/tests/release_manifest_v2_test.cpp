#include <array>
#include <cstddef>
#include <filesystem>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/bundle/release_manifest.hpp>
#include <lucent/os/file.hpp>

#include "vector_files.hpp"

// The release manifest's version 2: its golden vectors in contracts/release-manifest/v2 (each a
// .bin and a .json stating its contents, the derived manifest digest and the core capabilities'
// facts, rewritten with LUCENT_WRITE_VECTORS=1 by `moon run bundle:vectors`), and the refusals,
// made from bytes laid out by hand so they state the format independently of the encoder.

namespace lucent::bundle {
namespace {

// The low `Width` bytes of a value, little-endian.
template <usize Width>
auto little(u64 value) -> std::array<std::byte, Width> {
    std::array<std::byte, Width> bytes{};
    for (usize index = 0; index < Width; ++index) {
        bytes.at(index) = static_cast<std::byte>((value >> (8U * index)) & 0xffU);
    }
    return bytes;
}

auto text_bytes(std::string_view text) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.append_range(little<1>(text.size()));
    out.append_range(std::as_bytes(std::span{text}));
    return out;
}

struct raw_feature {
    u64 key = 0;
    std::string tag;
};

// One fact, one core capability over it, then the features as given.
struct raw_manifest {
    u16 version = 2;
    std::string product = "cs2";
    std::vector<raw_feature> features;
};

auto bytes_of(const raw_manifest& raw) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.append_range(little<4>(0x314d'524c));
    out.append_range(little<2>(raw.version));
    out.append_range(text_bytes(raw.product));
    out.append_range(little<4>(1));
    out.append_range(little<8>(0x10));
    out.append_range(little<1>(1));
    out.append_range(little<4>(1));
    out.append_range(little<8>(0xc1));
    out.append_range(little<1>(1));
    out.append_range(little<4>(1));
    out.append_range(little<8>(0x10));
    out.append_range(little<4>(raw.features.size()));
    for (const raw_feature& feature : raw.features) {
        out.append_range(little<8>(feature.key));
        out.append_range(text_bytes(feature.tag));
    }
    return out;
}

auto valid() -> raw_manifest {
    return raw_manifest{
        .features = {
            raw_feature{.key = 0xf1, .tag = "visuals"},
            raw_feature{.key = 0xf2, .tag = "aim"},
        },
    };
}

// Nothing when the bytes decode.
auto error_of(std::span<const std::byte> bytes) -> std::optional<error_code> {
    const result<release_manifest_v2> decoded = decode_release_manifest_v2(bytes);
    return decoded ? std::nullopt : std::optional{decoded.error().code};
}

auto error_of(const raw_manifest& raw) -> std::optional<error_code> {
    return error_of(bytes_of(raw));
}

constexpr std::optional<error_code> malformed = error_code::malformed;

TEST_CASE("a canonical version 2 manifest decodes to what was laid out, and encodes back to it") {
    const std::vector<std::byte> bytes = bytes_of(valid());

    const result<release_manifest_v2> decoded = decode_release_manifest_v2(bytes);

    REQUIRE(decoded.has_value());
    CHECK(decoded->product == "cs2");
    CHECK(
        decoded->features
        == std::vector{
            manifest_feature{.key = 0xf1, .tag = "visuals"},
            manifest_feature{.key = 0xf2, .tag = "aim"},
        }
    );
    CHECK(encode_release_manifest_v2(*decoded) == bytes);
}

TEST_CASE("each version's decoder calls the other version's bytes a version mismatch") {
    const std::vector<std::byte> second = bytes_of(valid());
    const std::vector<std::byte> first =
        encode_release_manifest(release_manifest{.game = 730, .facts = {}, .capabilities = {}});

    const result<release_manifest> as_first = decode_release_manifest(second);
    const result<release_manifest_v2> as_second = decode_release_manifest_v2(first);

    REQUIRE_FALSE(as_first.has_value());
    REQUIRE_FALSE(as_second.has_value());
    CHECK(as_first.error().code == error_code::version_mismatch);
    CHECK(as_second.error().code == error_code::version_mismatch);
}

TEST_CASE("a version 2 manifest's features are sorted, unique and non-zero, with valid tags") {
    raw_manifest unsorted = valid();
    std::swap(unsorted.features.front(), unsorted.features.back());
    raw_manifest repeated = valid();
    repeated.features.back().key = repeated.features.front().key;
    raw_manifest zero = valid();
    zero.features.front().key = 0;
    raw_manifest capital = valid();
    capital.features.front().tag = "Visuals";
    raw_manifest empty_tag = valid();
    empty_tag.features.front().tag = "";
    raw_manifest long_tag = valid();
    long_tag.features.front().tag = std::string(65, 'a');

    CHECK(error_of(unsorted) == malformed);
    CHECK(error_of(repeated) == malformed);
    CHECK(error_of(zero) == malformed);
    CHECK(error_of(capital) == malformed);
    CHECK(error_of(empty_tag) == malformed);
    CHECK(error_of(long_tag) == malformed);
}

TEST_CASE("a version 2 manifest names a product id, not a free string") {
    raw_manifest empty = valid();
    empty.product = "";
    raw_manifest spaced = valid();
    spaced.product = "counter strike";
    raw_manifest long_product = valid();
    long_product.product = std::string(33, 'a');

    CHECK(error_of(empty) == malformed);
    CHECK(error_of(spaced) == malformed);
    CHECK(error_of(long_product) == malformed);
}

TEST_CASE("a version 2 manifest cut short or followed by more bytes is malformed") {
    const std::vector<std::byte> bytes = bytes_of(valid());
    std::vector<std::byte> extended = bytes;
    extended.push_back(std::byte{0});

    for (usize size = 0; size < bytes.size(); ++size) {
        INFO(size);
        CHECK(error_of(std::span{bytes}.first(size)) == malformed);
    }
    CHECK(error_of(extended) == malformed);
}

}

namespace vectors {
namespace {

struct vector_case {
    std::string_view name;
    release_manifest_v2 manifest;
};

auto key_text(u64 key) -> std::string {
    return json_string(std::format("{:016x}", key));
}

auto keys_json(std::span<const u64> keys, usize indent) -> std::string {
    std::vector<std::string> items;
    items.reserve(keys.size());
    for (const u64 key : keys) {
        items.push_back(key_text(key));
    }
    return array(items, indent);
}

auto json_of(const release_manifest_v2& manifest) -> std::string {
    std::vector<std::string> facts;
    facts.reserve(manifest.facts.size());
    for (const manifest_entry& fact : manifest.facts) {
        facts.push_back(object(
            {
                json_field{.name = "key", .value = key_text(fact.key)},
                json_field{.name = "kind", .value = std::format("{}", fact.kind)},
            },
            4
        ));
    }
    std::vector<std::string> capabilities;
    capabilities.reserve(manifest.capabilities.size());
    for (const manifest_capability& capability : manifest.capabilities) {
        capabilities.push_back(object(
            {
                json_field{.name = "key", .value = key_text(capability.key)},
                json_field{
                    .name = "level",
                    .value = json_string(
                        capability.level == capability_level::core ? "core" : "optional"
                    ),
                },
                json_field{.name = "members", .value = keys_json(capability.members, 6)},
            },
            4
        ));
    }
    std::vector<std::string> features;
    features.reserve(manifest.features.size());
    for (const manifest_feature& feature : manifest.features) {
        features.push_back(object(
            {
                json_field{.name = "key", .value = key_text(feature.key)},
                json_field{.name = "tag", .value = json_string(feature.tag)},
            },
            4
        ));
    }
    return object(
               {
                   json_field{.name = "format", .value = "2"},
                   json_field{.name = "product", .value = json_string(manifest.product)},
                   json_field{
                       .name = "manifest_digest",
                       .value = json_string(hex(manifest_digest(manifest))),
                   },
                   json_field{.name = "facts", .value = array(facts, 2)},
                   json_field{.name = "capabilities", .value = array(capabilities, 2)},
                   json_field{.name = "features", .value = array(features, 2)},
                   json_field{
                       .name = "core_facts",
                       .value = keys_json(core_fact_keys(manifest), 2),
                   },
               },
               0
           )
           + "\n";
}

auto cases() -> std::vector<vector_case> {
    return {
        vector_case{
            .name = "empty",
            .manifest =
                release_manifest_v2{
                    .product = "cs2",
                    .facts = {},
                    .capabilities = {},
                    .features = {},
                },
        },
        vector_case{
            .name = "features",
            .manifest = release_manifest_v2{
                .product = "cs2",
                .facts =
                    {
                        manifest_entry{.key = 0x10, .kind = 1},
                        manifest_entry{.key = 0x20, .kind = 4},
                        manifest_entry{.key = 0x30, .kind = 5},
                    },
                .capabilities =
                    {
                        manifest_capability{
                            .key = 0x0c01,
                            .level = capability_level::core,
                            .members = {0x10, 0x30},
                        },
                        manifest_capability{
                            .key = 0x0c02,
                            .level = capability_level::optional,
                            .members = {0x20},
                        },
                    },
                .features = {
                    manifest_feature{.key = 0x0f01, .tag = "visuals"},
                    manifest_feature{.key = 0x0f02, .tag = "aim"},
                    manifest_feature{.key = 0x0f03, .tag = "movement.v2"},
                },
            },
        },
    };
}

auto write_vector(const vector_case& vector) -> void {
    const std::filesystem::path directory = directory_of("release-manifest", "v2");
    const std::vector<std::byte> bytes = encode_release_manifest_v2(vector.manifest);
    const std::string json = json_of(vector.manifest);
    std::filesystem::create_directories(directory);
    REQUIRE(os::write_file(directory / std::format("{}.bin", vector.name), bytes).has_value());
    REQUIRE(
        os::write_file(
            directory / std::format("{}.json", vector.name), std::as_bytes(std::span{json})
        )
            .has_value()
    );
}

auto check_vector(const vector_case& vector) -> void {
    const std::filesystem::path directory = directory_of("release-manifest", "v2");
    const result<std::vector<std::byte>> stored_bytes =
        os::read_file(directory / std::format("{}.bin", vector.name));
    const result<std::vector<std::byte>> stored_json =
        os::read_file(directory / std::format("{}.json", vector.name));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());

    const result<release_manifest_v2> decoded = decode_release_manifest_v2(*stored_bytes);

    REQUIRE(decoded.has_value());
    CHECK(*decoded == vector.manifest);
    CHECK(encode_release_manifest_v2(*decoded) == *stored_bytes);
    CHECK(as_text(*stored_json) == json_of(*decoded));
}

TEST_CASE("each version 2 release manifest golden vector decodes and re-encodes to its bytes") {
    for (const vector_case& vector : cases()) {
        if (should_write()) {
            write_vector(vector);
        }
        check_vector(vector);
    }
}

}
}
}
