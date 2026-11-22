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

// The release manifest's version 3: its golden vectors in contracts/release-manifest/v3 (each a
// .bin and a .json stating its contents, the derived manifest digest, the modules its facts resolve
// in, and the core capabilities' facts overall and per module, rewritten with
// LUCENT_WRITE_VECTORS=1 by `moon run bundle:vectors`), and the refusals, made from bytes laid out
// by hand so they state the format independently of the encoder.

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

struct raw_fact {
    u64 key = 0;
    u64 module = 0;
};

// The facts as given, each of kind 1, one core capability over the first, one feature.
struct raw_manifest {
    u16 version = 3;
    std::vector<raw_fact> facts;
};

auto bytes_of(const raw_manifest& raw) -> std::vector<std::byte> {
    std::vector<std::byte> out;
    out.append_range(little<4>(0x314d'524c));
    out.append_range(little<2>(raw.version));
    out.append_range(text_bytes("cs2"));
    out.append_range(little<4>(raw.facts.size()));
    for (const raw_fact& fact : raw.facts) {
        out.append_range(little<8>(fact.key));
        out.append_range(little<1>(1));
        out.append_range(little<8>(fact.module));
    }
    out.append_range(little<4>(1));
    out.append_range(little<8>(0xc1));
    out.append_range(little<1>(1));
    out.append_range(little<4>(1));
    out.append_range(little<8>(raw.facts.front().key));
    out.append_range(little<4>(1));
    out.append_range(little<8>(0xf1));
    out.append_range(text_bytes("visuals"));
    return out;
}

auto valid() -> raw_manifest {
    return raw_manifest{
        .facts = {
            raw_fact{.key = 0x10, .module = 0xaa},
            raw_fact{.key = 0x20, .module = 0xbb},
        },
    };
}

// Nothing when the bytes decode.
auto error_of(std::span<const std::byte> bytes) -> std::optional<error_code> {
    const result<release_manifest_v3> decoded = decode_release_manifest_v3(bytes);
    return decoded ? std::nullopt : std::optional{decoded.error().code};
}

auto error_of(const raw_manifest& raw) -> std::optional<error_code> {
    return error_of(bytes_of(raw));
}

constexpr std::optional<error_code> malformed = error_code::malformed;

TEST_CASE("a canonical version 3 manifest decodes each fact with its module, and encodes back") {
    const std::vector<std::byte> bytes = bytes_of(valid());

    const result<release_manifest_v3> decoded = decode_release_manifest_v3(bytes);

    REQUIRE(decoded.has_value());
    CHECK(
        decoded->facts
        == std::vector{
            manifest_fact{.key = 0x10, .kind = 1, .module = 0xaa},
            manifest_fact{.key = 0x20, .kind = 1, .module = 0xbb},
        }
    );
    CHECK(encode_release_manifest_v3(*decoded) == bytes);
}

TEST_CASE("version 3's decoder calls version 1 and 2 bytes a version mismatch, and they it") {
    const std::vector<std::byte> third = bytes_of(valid());
    const std::vector<std::byte> first =
        encode_release_manifest(release_manifest{.game = 730, .facts = {}, .capabilities = {}});
    const std::vector<std::byte> second = encode_release_manifest_v2(
        release_manifest_v2{.product = "cs2", .facts = {}, .capabilities = {}, .features = {}}
    );

    CHECK(error_of(first) == error_code::version_mismatch);
    CHECK(error_of(second) == error_code::version_mismatch);
    CHECK(decode_release_manifest(third).error().code == error_code::version_mismatch);
    CHECK(decode_release_manifest_v2(third).error().code == error_code::version_mismatch);
}

TEST_CASE("a version 3 fact never names module hash 0") {
    raw_manifest zero = valid();
    zero.facts.back().module = 0;

    CHECK(error_of(zero) == malformed);
}

TEST_CASE("a version 3 manifest's facts are sorted and unique, whatever their modules") {
    raw_manifest unsorted = valid();
    std::swap(unsorted.facts.front(), unsorted.facts.back());
    raw_manifest repeated = valid();
    repeated.facts.back().key = repeated.facts.front().key;

    CHECK(error_of(unsorted) == malformed);
    CHECK(error_of(repeated) == malformed);
}

TEST_CASE("a version 3 manifest cut short or followed by more bytes is malformed") {
    const std::vector<std::byte> bytes = bytes_of(valid());
    std::vector<std::byte> extended = bytes;
    extended.push_back(std::byte{0});

    for (usize size = 0; size < bytes.size(); ++size) {
        INFO(size);
        CHECK(error_of(std::span{bytes}.first(size)) == malformed);
    }
    CHECK(error_of(extended) == malformed);
}

TEST_CASE("a module's core facts are the core capabilities' facts that resolve in it") {
    const release_manifest_v3 manifest{
        .product = "cs2",
        .facts =
            {
                manifest_fact{.key = 0x10, .kind = 1, .module = 0xaa},
                manifest_fact{.key = 0x20, .kind = 1, .module = 0xbb},
                manifest_fact{.key = 0x30, .kind = 1, .module = 0xaa},
                manifest_fact{.key = 0x40, .kind = 1, .module = 0xbb},
            },
        .capabilities =
            {
                manifest_capability{
                    .key = 0xc1,
                    .level = capability_level::core,
                    .members = {0x10, 0x20},
                },
                manifest_capability{
                    .key = 0xc2,
                    .level = capability_level::optional,
                    .members = {0x30, 0x40},
                },
            },
        .features = {},
    };

    CHECK(fact_modules(manifest) == std::vector<u64>{0xaa, 0xbb});
    CHECK(core_fact_keys(manifest) == std::vector<u64>{0x10, 0x20});
    CHECK(core_fact_keys(manifest, 0xaa) == std::vector<u64>{0x10});
    CHECK(core_fact_keys(manifest, 0xbb) == std::vector<u64>{0x20});
    CHECK(core_fact_keys(manifest, 0xcc).empty());
}

TEST_CASE("a version 3 manifest's digest ignores the modules, so it matches the module's own") {
    const release_manifest_v3 located{
        .product = "cs2",
        .facts = {manifest_fact{.key = 0x10, .kind = 4, .module = 0xaa}},
        .capabilities = {},
        .features = {},
    };

    CHECK(
        manifest_digest(located)
        == manifest_digest(std::vector{manifest_entry{.key = 0x10, .kind = 4}})
    );
}

}

namespace vectors {
namespace {

struct vector_case {
    std::string_view name;
    release_manifest_v3 manifest;
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

auto core_by_module_json(const release_manifest_v3& manifest) -> std::string {
    std::vector<std::string> modules;
    for (const u64 module : fact_modules(manifest)) {
        modules.push_back(object(
            {
                json_field{.name = "module", .value = key_text(module)},
                json_field{
                    .name = "core_facts",
                    .value = keys_json(core_fact_keys(manifest, module), 6),
                },
            },
            4
        ));
    }
    return array(modules, 2);
}

auto json_of(const release_manifest_v3& manifest) -> std::string {
    std::vector<std::string> facts;
    facts.reserve(manifest.facts.size());
    for (const manifest_fact& fact : manifest.facts) {
        facts.push_back(object(
            {
                json_field{.name = "key", .value = key_text(fact.key)},
                json_field{.name = "kind", .value = std::format("{}", fact.kind)},
                json_field{.name = "module", .value = key_text(fact.module)},
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
                   json_field{.name = "format", .value = "3"},
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
                   json_field{
                       .name = "core_facts_by_module",
                       .value = core_by_module_json(manifest),
                   },
               },
               0
           )
           + "\n";
}

// Two module name hashes, arbitrary: the format treats them as opaque non-zero values.
constexpr u64 first_module = 0x3e8e'1cfb'1b80'4bb8;
constexpr u64 second_module = 0x9d1a'f27c'f6f2'3b8f;

auto cases() -> std::vector<vector_case> {
    return {
        vector_case{
            .name = "empty",
            .manifest =
                release_manifest_v3{
                    .product = "cs2",
                    .facts = {},
                    .capabilities = {},
                    .features = {},
                },
        },
        vector_case{
            .name = "modules",
            .manifest = release_manifest_v3{
                .product = "cs2",
                .facts =
                    {
                        manifest_fact{.key = 0x10, .kind = 1, .module = first_module},
                        manifest_fact{.key = 0x20, .kind = 4, .module = first_module},
                        manifest_fact{.key = 0x30, .kind = 5, .module = second_module},
                        manifest_fact{.key = 0x40, .kind = 0, .module = second_module},
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
                            .members = {0x20, 0x40},
                        },
                    },
                .features = {
                    manifest_feature{.key = 0x0f01, .tag = "visuals"},
                    manifest_feature{.key = 0x0f02, .tag = "aim"},
                },
            },
        },
    };
}

auto write_vector(const vector_case& vector) -> void {
    const std::filesystem::path directory = directory_of("release-manifest", "v3");
    const std::vector<std::byte> bytes = encode_release_manifest_v3(vector.manifest);
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
    const std::filesystem::path directory = directory_of("release-manifest", "v3");
    const result<std::vector<std::byte>> stored_bytes =
        os::read_file(directory / std::format("{}.bin", vector.name));
    const result<std::vector<std::byte>> stored_json =
        os::read_file(directory / std::format("{}.json", vector.name));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());

    const result<release_manifest_v3> decoded = decode_release_manifest_v3(*stored_bytes);

    REQUIRE(decoded.has_value());
    CHECK(*decoded == vector.manifest);
    CHECK(encode_release_manifest_v3(*decoded) == *stored_bytes);
    CHECK(as_text(*stored_json) == json_of(*decoded));
}

TEST_CASE("each version 3 release manifest golden vector decodes and re-encodes to its bytes") {
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
