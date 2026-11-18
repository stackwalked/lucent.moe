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

#include <catch2/catch_test_macros.hpp>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>

#include "fixtures.hpp"

// The format's golden vectors in contracts/fact-bundle/v1: every implementation (this one, the
// generator's encoder, the TS server) must produce and accept exactly these bytes. Each vector is
// a .bin and a .json stating its inputs and expected decode. They're compared byte for byte; run
// with LUCENT_WRITE_VECTORS=1 (`moon run bundle:vectors`) to rewrite them, then review the diff.

namespace lucent::bundle {
namespace {

struct vector_case {
    std::string_view name;
    std::vector<delivered_set> sets;
};

auto hex(std::span<const std::byte> bytes) -> std::string {
    std::string out;
    for (const std::byte value : bytes) {
        out += std::format("{:02x}", static_cast<u8>(value));
    }
    return out;
}

// The vectors' JSON is fully expanded, one member or item per line, which is the layout the
// repo's JSON formatter keeps as it is.
struct json_field {
    std::string_view name;
    std::string value;
};

auto spaces(usize count) -> std::string {
    std::string padding;
    padding.resize(count, ' ');
    return padding;
}

auto json_string(std::string_view text) -> std::string {
    return std::format("\"{}\"", text);
}

auto object(const std::vector<json_field>& fields, usize indent) -> std::string {
    std::string out = "{\n";
    for (usize index = 0; const json_field& field : fields) {
        const std::string_view separator = index + 1 < fields.size() ? "," : "";
        out +=
            std::format("{}\"{}\": {}{}\n", spaces(indent + 2), field.name, field.value, separator);
        ++index;
    }
    return out + spaces(indent) + "}";
}

auto array(const std::vector<std::string>& items, usize indent) -> std::string {
    if (items.empty()) {
        return "[]";
    }
    std::string out = "[\n";
    for (usize index = 0; const std::string& item : items) {
        const std::string_view separator = index + 1 < items.size() ? "," : "";
        out += std::format("{}{}{}\n", spaces(indent + 2), item, separator);
        ++index;
    }
    return out + spaces(indent) + "]";
}

auto set_json(const delivered_set& set, usize indent) -> std::string {
    std::vector<std::string> modules;
    modules.reserve(set.header.modules.size());
    for (const module_key& module : set.header.modules) {
        modules.push_back(object(
            {
                json_field{
                    .name = "name_hash",
                    .value = json_string(std::format("{:016x}", module.name_hash)),
                },
                json_field{
                    .name = "time_date_stamp",
                    .value = json_string(std::format("{:08x}", module.time_date_stamp)),
                },
                json_field{
                    .name = "size_of_image",
                    .value = json_string(std::format("{:08x}", module.size_of_image)),
                },
            },
            indent + 4
        ));
    }
    std::vector<std::string> delivered;
    delivered.reserve(set.entries.size());
    for (const delivered_entry& given : set.entries) {
        delivered.push_back(object(
            {
                json_field{.name = "index", .value = std::format("{}", given.index)},
                json_field{
                    .name = "key",
                    .value = json_string(std::format("{:016x}", given.value.key)),
                },
                json_field{
                    .name = "literal",
                    .value =
                        json_string(std::format("{:016x}", literal_value(given.value).value_or(0))),
                },
            },
            indent + 4
        ));
    }
    std::vector<std::string> proof;
    proof.reserve(set.proof.size());
    for (const crypto::digest& hash : set.proof) {
        proof.push_back(json_string(hex(hash)));
    }
    return object(
        {
            json_field{.name = "game", .value = std::format("{}", set.header.game)},
            json_field{.name = "revision", .value = std::format("{}", set.header.revision)},
            json_field{.name = "modules", .value = array(modules, indent + 2)},
            json_field{
                .name = "finders_commit",
                .value = json_string(hex(set.header.finders_commit)),
            },
            json_field{
                .name = "manifest_digest",
                .value = json_string(hex(set.header.manifest_digest)),
            },
            json_field{.name = "entry_count", .value = std::format("{}", set.header.entry_count)},
            json_field{.name = "merkle_root", .value = json_string(hex(set.header.merkle_root))},
            json_field{.name = "signature", .value = json_string(hex(set.header.signature))},
            json_field{.name = "delivered", .value = array(delivered, indent + 2)},
            json_field{.name = "proof", .value = array(proof, indent + 2)},
        },
        indent
    );
}

auto json_of(const vector_case& vector) -> std::string {
    std::vector<std::string> sets;
    sets.reserve(vector.sets.size());
    for (const delivered_set& set : vector.sets) {
        sets.push_back(set_json(set, 4));
    }
    return object(
               {
                   json_field{.name = "format", .value = "1"},
                   json_field{
                       .name = "signer_public_key",
                       .value = json_string(hex(fixtures::signer().public_part())),
                   },
                   json_field{.name = "sets", .value = array(sets, 2)},
               },
               0
           )
           + "\n";
}

auto cases() -> std::vector<vector_case> {
    const fact_set five = fixtures::fact_set_of(5);
    const fact_set nine = fixtures::fact_set_of(9);
    const std::array chosen{nine.entries.at(2).key, nine.entries.at(7).key};
    const fact_set composite = sign_fact_set(
        fixtures::header_of({
            module_key{.name_hash = 0x0aaa, .time_date_stamp = 1, .size_of_image = 0x1000},
            fixtures::client_module(),
            module_key{.name_hash = 0x0bbb, .time_date_stamp = 2, .size_of_image = 0x2000},
        }),
        {literal(0x30, 7), literal(0x10, 5), literal(0x20, 6)},
        fixtures::signer()
    );
    return {
        vector_case{.name = "full", .sets = {deliver_all(five)}},
        vector_case{.name = "subset", .sets = {deliver(nine, chosen)}},
        vector_case{.name = "composite", .sets = {deliver_all(composite)}},
    };
}

auto should_write() -> bool {
    std::array<wchar_t, 2> value{};
    return GetEnvironmentVariableW(L"LUCENT_WRITE_VECTORS", value.data(), 2) == 1
           && value.front() == L'1';
}

auto as_text(std::span<const std::byte> bytes) -> std::string {
    std::string text;
    for (const std::byte value : bytes) {
        text.push_back(static_cast<char>(value));
    }
    return text;
}

auto vector_directory() -> std::filesystem::path {
    return std::filesystem::path{LUCENT_CONTRACTS_DIR} / "fact-bundle" / "v1";
}

// Rewrites the vector's files; only under LUCENT_WRITE_VECTORS=1.
auto write_vector(const vector_case& vector) -> void {
    const std::vector<std::byte> bytes = encode_bundle(vector.sets);
    const std::string json = json_of(vector);
    std::filesystem::create_directories(vector_directory());
    REQUIRE(
        os::write_file(vector_directory() / std::format("{}.bin", vector.name), bytes).has_value()
    );
    REQUIRE(
        os::write_file(
            vector_directory() / std::format("{}.json", vector.name), std::as_bytes(std::span{json})
        )
            .has_value()
    );
}

auto check_vector(const vector_case& vector) -> void {
    const std::array<crypto::public_key, 1> trusted{fixtures::signer().public_part()};
    const result<std::vector<std::byte>> stored_bytes =
        os::read_file(vector_directory() / std::format("{}.bin", vector.name));
    const result<std::vector<std::byte>> stored_json =
        os::read_file(vector_directory() / std::format("{}.json", vector.name));
    REQUIRE(stored_bytes.has_value());
    REQUIRE(stored_json.has_value());
    const result<std::vector<delivered_set>> decoded = decode_bundle(*stored_bytes);
    REQUIRE(decoded.has_value());

    CHECK(*stored_bytes == encode_bundle(vector.sets));
    CHECK(as_text(*stored_json) == json_of(vector));
    CHECK(std::ranges::all_of(*decoded, [&](const delivered_set& set) {
        return verify(set, trusted).has_value();
    }));
}

TEST_CASE("the encoder reproduces the format's golden vectors, and the decoder reads them back") {
    for (const vector_case& vector : cases()) {
        if (should_write()) {
            write_vector(vector);
        }
        check_vector(vector);
    }
}

}
}
