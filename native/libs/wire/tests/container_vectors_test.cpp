#include <algorithm>
#include <array>
#include <cstddef>
#include <filesystem>
#include <format>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <Windows.h>

#include <catch2/catch_message.hpp>
#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>
#include <lucent/wire/container.hpp>
#include <lucent/wire/container_stream.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/release_seal.hpp>

#include "container_fixtures.hpp"
#include "json.hpp"

// The golden vectors of contracts/container/v1, contracts/container-stream/v1 and
// contracts/release-seal/v1: each a .bin and a .json stating its contents, which the TS server
// checks too. Rewritten with LUCENT_WRITE_VECTORS=1 (`moon run wire:vectors`); review the diff.

namespace lucent::wire {
namespace {

auto access_name(section_access access) -> std::string_view {
    switch (access) {
    case section_access::read:
        return "read";
    case section_access::read_write:
        return "read_write";
    case section_access::read_execute:
        return "read_execute";
    }
    LUCENT_UNREACHABLE();
}

auto kind_name(artifact_kind kind) -> std::string_view {
    switch (kind) {
    case artifact_kind::container:
        return "container";
    case artifact_kind::release_manifest:
        return "release_manifest";
    case artifact_kind::loader:
        return "loader";
    case artifact_kind::host:
        return "host";
    }
    LUCENT_UNREACHABLE();
}

auto channel_text(channel chosen) -> std::string_view {
    switch (chosen) {
    case channel::stable:
        return "stable";
    case channel::alpha:
        return "alpha";
    case channel::debug:
        return "debug";
    }
    LUCENT_UNREACHABLE();
}

auto number(u64 value) -> std::string {
    return std::format("{}", value);
}

auto container_json(const container& image) -> std::string {
    std::vector<std::string> sections;
    sections.reserve(image.sections.size());
    for (const container_section& section : image.sections) {
        sections.push_back(object(
            {
                field{.name = "rva", .value = number(section.rva)},
                field{.name = "mapped_size", .value = number(section.mapped_size)},
                field{.name = "access", .value = json_string(access_name(section.access))},
                field{.name = "data", .value = hex_field(section.data)},
            },
            4
        ));
    }
    std::vector<std::string> relocations;
    relocations.reserve(image.relocations.size());
    for (const u32 slot : image.relocations) {
        relocations.push_back(number(slot));
    }
    std::vector<std::string> imports;
    imports.reserve(image.imports.size());
    for (const container_import& each : image.imports) {
        imports.push_back(object(
            {
                field{.name = "module_hash", .value = u64_field(each.module_hash)},
                field{.name = "function_hash", .value = u64_field(each.function_hash)},
                field{.name = "slot_rva", .value = number(each.slot_rva)},
            },
            4
        ));
    }
    return object(
        {
            field{.name = "release", .value = hex_field(image.release.bytes)},
            field{.name = "image_size", .value = number(image.image_size)},
            field{.name = "entry_rva", .value = number(image.entry_rva)},
            field{.name = "boot_rva", .value = number(image.boot_rva)},
            field{.name = "boot_info_version", .value = number(image.boot_info_version)},
            field{.name = "pdata_rva", .value = number(image.pdata_rva)},
            field{.name = "pdata_size", .value = number(image.pdata_size)},
            field{.name = "imports_key", .value = hex_field(image.imports_key)},
            field{.name = "sections", .value = array(sections, 2)},
            field{.name = "relocations", .value = array(relocations, 2)},
            field{.name = "imports", .value = array(imports, 2)},
            field{.name = "body", .value = hex_field(encode_container_body(image))},
        },
        0
    );
}

auto stream_json(usize plain_size) -> std::string {
    const usize count = chunk_count(plain_size);
    std::vector<std::string> nonces;
    nonces.reserve(count);
    std::vector<std::string> associated;
    associated.reserve(count);
    for (usize index = 0; index < count; ++index) {
        nonces.push_back(hex_field(fixtures::stream_nonces(count).at(index)));
        const chunk_position position =
            index + 1 == count ? chunk_position::last : chunk_position::inner;
        associated.push_back(hex_field(chunk_associated_data(narrow<u32>(index), position)));
    }
    return object(
        {
            field{.name = "key", .value = hex_field(fixtures::container_key().as_bytes())},
            field{.name = "plain_size", .value = number(plain_size)},
            field{.name = "plain", .value = json_string("byte i is i mod 251")},
            field{.name = "nonces", .value = array(nonces, 2)},
            field{.name = "associated_data", .value = array(associated, 2)},
        },
        0
    );
}

auto seal_json(const release_seal& seal) -> std::string {
    std::vector<std::string> artifacts;
    artifacts.reserve(seal.artifacts.size());
    for (const release_artifact& artifact : seal.artifacts) {
        artifacts.push_back(object(
            {
                field{.name = "kind", .value = json_string(kind_name(artifact.kind))},
                field{.name = "digest", .value = hex_field(artifact.digest)},
            },
            4
        ));
    }
    return object(
        {
            field{.name = "product", .value = json_string(seal.product)},
            field{.name = "channel", .value = json_string(channel_text(seal.chosen))},
            field{.name = "number", .value = number(seal.number)},
            field{.name = "release", .value = hex_field(seal.release.bytes)},
            field{.name = "boot_info_version", .value = number(seal.boot_info_version)},
            field{.name = "artifacts", .value = array(artifacts, 2)},
            field{.name = "signature", .value = hex_field(seal.signature)},
            field{
                .name = "code_public_key",
                .value =
                    hex_field(crypto::signing_key::from_seed(fixtures::code_seed).public_part()),
            },
            field{.name = "signed_bytes", .value = hex_field(release_seal_signed_bytes(seal))},
        },
        0
    );
}

auto stream_of(usize plain_size) -> std::vector<std::byte> {
    return seal_container_stream(
        fixtures::container_key(),
        fixtures::stream_plain(plain_size),
        fixtures::stream_nonces(chunk_count(plain_size))
    );
}

struct vector_case {
    std::string_view contract;
    std::string_view name;
    std::vector<std::byte> bytes;
    std::string json;
    // The bytes as the vector's decoder reads them and its encoder writes them again.
    auto (*round_trip)(std::span<const std::byte>) -> result<std::vector<std::byte>> = nullptr;
};

auto container_round_trip(std::span<const std::byte> bytes) -> result<std::vector<std::byte>> {
    return unpack_container(bytes).transform(pack_container);
}

auto stream_round_trip(std::span<const std::byte> bytes) -> result<std::vector<std::byte>> {
    const std::vector<std::byte> plain =
        LUCENT_TRY(open_container_stream(fixtures::container_key(), bytes));
    return seal_container_stream(
        fixtures::container_key(), plain, fixtures::stream_nonces(chunk_count(plain.size()))
    );
}

auto seal_round_trip(std::span<const std::byte> bytes) -> result<std::vector<std::byte>> {
    const crypto::public_key code_key =
        crypto::signing_key::from_seed(fixtures::code_seed).public_part();
    return verify_release_seal(bytes, code_key).transform(encode_release_seal);
}

auto cases() -> std::vector<vector_case> {
    return {
        vector_case{
            .contract = "container",
            .name = "small",
            .bytes = pack_container(fixtures::small_container()),
            .json = container_json(fixtures::small_container()),
            .round_trip = container_round_trip,
        },
        vector_case{
            .contract = "container",
            .name = "empty",
            .bytes = pack_container(fixtures::empty_container()),
            .json = container_json(fixtures::empty_container()),
            .round_trip = container_round_trip,
        },
        vector_case{
            .contract = "container-stream",
            .name = "two_chunks",
            .bytes = stream_of(fixtures::stream_plain_size),
            .json = stream_json(fixtures::stream_plain_size),
            .round_trip = stream_round_trip,
        },
        vector_case{
            .contract = "container-stream",
            .name = "empty",
            .bytes = stream_of(0),
            .json = stream_json(0),
            .round_trip = stream_round_trip,
        },
        vector_case{
            .contract = "release-seal",
            .name = "module",
            .bytes = encode_release_seal(fixtures::module_seal()),
            .json = seal_json(fixtures::module_seal()),
            .round_trip = seal_round_trip,
        },
        vector_case{
            .contract = "release-seal",
            .name = "loader",
            .bytes = encode_release_seal(fixtures::loader_seal()),
            .json = seal_json(fixtures::loader_seal()),
            .round_trip = seal_round_trip,
        },
    };
}

auto directory_of(std::string_view contract) -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / contract / "v1";
}

auto should_write() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_WRITE_VECTORS", value.data(), 2) == 1
           && value.front() == L'1';
}

auto path_of(const vector_case& vector, std::string_view extension) -> std::filesystem::path {
    return directory_of(vector.contract) / std::format("{}.{}", vector.name, extension);
}

auto write_vector(const vector_case& vector) -> void {
    const std::string json = vector.json + "\n";
    std::filesystem::create_directories(directory_of(vector.contract));
    REQUIRE(os::write_file(path_of(vector, "bin"), vector.bytes).has_value());
    REQUIRE(os::write_file(path_of(vector, "json"), std::as_bytes(std::span{json})).has_value());
}

auto check_vector(const vector_case& vector) -> void {
    INFO(std::format("{}/{}", vector.contract, vector.name));
    const result<std::vector<std::byte>> stored_bytes = os::read_file(path_of(vector, "bin"));
    const result<std::vector<std::byte>> stored_json = os::read_file(path_of(vector, "json"));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());
    const std::string json = vector.json + "\n";

    CHECK(*stored_bytes == vector.bytes);
    CHECK(vector.round_trip(*stored_bytes) == vector.bytes);
    CHECK(std::ranges::equal(*stored_json, std::as_bytes(std::span{json})));
}

TEST_CASE("each container, stream and seal golden vector is its source's encoding, and back") {
    for (const vector_case& vector : cases()) {
        if (should_write()) {
            write_vector(vector);
        }
        check_vector(vector);
    }
}

TEST_CASE("the golden module seal names the golden small container's digest") {
    const result<std::vector<std::byte>> container_bytes =
        os::read_file(directory_of("container") / "small.bin");
    const result<std::vector<std::byte>> seal_bytes =
        os::read_file(directory_of("release-seal") / "module.bin");
    REQUIRE(container_bytes.has_value());
    REQUIRE(seal_bytes.has_value());
    const result<release_seal> seal = decode_release_seal(*seal_bytes);
    REQUIRE(seal.has_value());

    CHECK(seal->artifacts.front().kind == artifact_kind::container);
    CHECK(seal->artifacts.front().digest == crypto::hash(*container_bytes));
}

}
}
