#include <cstddef>
#include <filesystem>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/bundle/release_manifest.hpp>
#include <lucent/os/file.hpp>

#include "vector_files.hpp"

// The release manifest's golden vectors in contracts/release-manifest/v1: each is a .bin and a
// .json stating its contents, the derived manifest digest and the core capabilities' facts, which
// every implementation (this one, the TS server) must agree on. Rewritten with
// LUCENT_WRITE_VECTORS=1 (`moon run bundle:vectors`); review the diff.

namespace lucent::bundle::vectors {
namespace {

struct vector_case {
    std::string_view name;
    release_manifest manifest;
};

auto key_text(u64 key) -> std::string {
    return json_string(std::format("{:016x}", key));
}

auto level_name(capability_level level) -> std::string_view {
    switch (level) {
    case capability_level::optional:
        return "optional";
    case capability_level::core:
        return "core";
    }
    LUCENT_UNREACHABLE();
}

auto keys_json(std::span<const u64> keys, usize indent) -> std::string {
    std::vector<std::string> items;
    items.reserve(keys.size());
    for (const u64 key : keys) {
        items.push_back(key_text(key));
    }
    return array(items, indent);
}

auto json_of(const release_manifest& manifest) -> std::string {
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
                    .value = json_string(level_name(capability.level)),
                },
                json_field{.name = "members", .value = keys_json(capability.members, 6)},
            },
            4
        ));
    }
    return object(
               {
                   json_field{.name = "format", .value = "1"},
                   json_field{.name = "game", .value = std::format("{}", manifest.game)},
                   json_field{
                       .name = "manifest_digest",
                       .value = json_string(hex(manifest_digest(manifest))),
                   },
                   json_field{.name = "facts", .value = array(facts, 2)},
                   json_field{
                       .name = "capabilities",
                       .value = array(capabilities, 2),
                   },
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
            .manifest = release_manifest{.game = 730, .facts = {}, .capabilities = {}},
        },
        vector_case{
            .name = "capabilities",
            .manifest = release_manifest{
                .game = 730,
                .facts =
                    {
                        manifest_entry{.key = 0x10, .kind = 1},
                        manifest_entry{.key = 0x20, .kind = 4},
                        manifest_entry{.key = 0x30, .kind = 5},
                        manifest_entry{.key = 0x40, .kind = 0},
                        manifest_entry{.key = 0x50, .kind = 2},
                    },
                .capabilities = {
                    manifest_capability{
                        .key = 0x0c01,
                        .level = capability_level::core,
                        .members = {0x10, 0x30},
                    },
                    manifest_capability{
                        .key = 0x0c02,
                        .level = capability_level::optional,
                        .members = {0x20, 0x30, 0x40},
                    },
                    manifest_capability{
                        .key = 0x0c03,
                        .level = capability_level::core,
                        .members = {0x30, 0x40},
                    },
                },
            },
        },
    };
}

auto write_vector(const vector_case& vector) -> void {
    const std::filesystem::path directory = directory_of("release-manifest");
    const std::vector<std::byte> bytes = encode_release_manifest(vector.manifest);
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
    const std::filesystem::path directory = directory_of("release-manifest");
    const result<std::vector<std::byte>> stored_bytes =
        os::read_file(directory / std::format("{}.bin", vector.name));
    const result<std::vector<std::byte>> stored_json =
        os::read_file(directory / std::format("{}.json", vector.name));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());

    const result<release_manifest> decoded = decode_release_manifest(*stored_bytes);

    REQUIRE(decoded.has_value());
    CHECK(*decoded == vector.manifest);
    CHECK(encode_release_manifest(*decoded) == *stored_bytes);
    CHECK(as_text(*stored_json) == json_of(*decoded));
}

TEST_CASE("each release manifest golden vector decodes and re-encodes to its bytes exactly") {
    for (const vector_case& vector : cases()) {
        if (should_write()) {
            write_vector(vector);
        }
        check_vector(vector);
    }
}

}
}
