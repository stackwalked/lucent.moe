#include "generate/manifest.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <print>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/bundle/release_manifest.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/os/file.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::facts {
namespace {

constexpr error malformed{.code = error_code::malformed};

// A section's bytes as the file stores them; none when the module doesn't have it.
auto section_bytes(const pe::image_view& image, std::string_view name)
    -> result<std::span<const std::byte>> {
    const auto section = std::ranges::find(image.sections(), name, &pe::section::name);
    if (section == image.sections().end()) {
        return std::span<const std::byte>{};
    }
    return image.contents_of(*section);
}

// The same reading as devkey's (tools/devkey/src/sign/dev_bundle.cpp): whole records from the
// section's start.
auto fact_records_in(std::span<const std::byte> bytes) -> std::vector<kit::fact_record> {
    std::vector<kit::fact_record> records;
    while (bytes.size() >= sizeof(kit::fact_record)) {
        std::array<std::byte, sizeof(kit::fact_record)> stored{};
        std::ranges::copy(bytes.first(sizeof(kit::fact_record)), stored.begin());
        const auto record = std::bit_cast<kit::fact_record>(stored);
        if (record.key != 0) {
            records.push_back(record);
        }
        bytes = bytes.subspan(sizeof(kit::fact_record));
    }
    return records;
}

auto level_of(kit::capability_level level) -> bundle::capability_level {
    switch (level) {
    case kit::capability_level::optional:
        return bundle::capability_level::optional;
    case kit::capability_level::core:
        return bundle::capability_level::core;
    }
    LUCENT_UNREACHABLE();
}

auto facts_of(std::span<const kit::fact_record> records)
    -> result<std::vector<bundle::manifest_entry>> {
    std::vector<bundle::manifest_entry> facts;
    facts.reserve(records.size());
    for (const kit::fact_record& record : records) {
        facts.push_back(
            bundle::manifest_entry{.key = record.key, .kind = std::to_underlying(record.kind)}
        );
    }
    std::ranges::sort(facts, {}, &bundle::manifest_entry::key);
    const auto repeated = std::ranges::adjacent_find(facts, {}, &bundle::manifest_entry::key);
    if (repeated != facts.end()) {
        std::println(stderr, "facts: two linked facts share the key {:#018x}", repeated->key);
        return std::unexpected(malformed);
    }
    return facts;
}

auto capability_of(
    const kit::declared_capability& declared, std::span<const bundle::manifest_entry> facts
) -> result<bundle::manifest_capability> {
    bundle::manifest_capability capability{
        .key = declared.key,
        .level = level_of(declared.level),
        .members = declared.members,
    };
    std::ranges::sort(capability.members);
    if (std::ranges::adjacent_find(capability.members) != capability.members.end()) {
        std::println(stderr, "facts: capability {:#018x} names a fact twice", declared.key);
        return std::unexpected(malformed);
    }
    for (const u64 member : capability.members) {
        if (!std::ranges::binary_search(facts, member, {}, &bundle::manifest_entry::key)) {
            std::println(
                stderr,
                "facts: capability {:#018x} names fact {:#018x}, which the module doesn't link",
                declared.key,
                member
            );
            return std::unexpected(malformed);
        }
    }
    return capability;
}

}

auto manifest_of(const std::filesystem::path& module) -> result<module_manifest> {
    const std::vector<std::byte> file = LUCENT_TRY(os::read_file(module));
    const pe::image_view image = LUCENT_TRY(pe::image_view::parse(file, pe::layout::file));
    const std::span<const std::byte> facts = LUCENT_TRY(section_bytes(image, ".lfact"));
    const std::span<const std::byte> capabilities = LUCENT_TRY(section_bytes(image, ".lcap"));
    return module_manifest{
        .facts = fact_records_in(facts),
        .capabilities = LUCENT_TRY(kit::declared_capabilities(capabilities)),
    };
}

auto release_manifest_of(const module_manifest& linked, u32 game)
    -> result<bundle::release_manifest> {
    bundle::release_manifest manifest{
        .game = game,
        .facts = LUCENT_TRY(facts_of(linked.facts)),
        .capabilities = {},
    };
    for (const kit::declared_capability& declared : linked.capabilities) {
        manifest.capabilities.push_back(LUCENT_TRY(capability_of(declared, manifest.facts)));
    }
    std::ranges::sort(manifest.capabilities, {}, &bundle::manifest_capability::key);
    const auto repeated =
        std::ranges::adjacent_find(manifest.capabilities, {}, &bundle::manifest_capability::key);
    if (repeated != manifest.capabilities.end()) {
        std::println(stderr, "facts: two capabilities share the key {:#018x}", repeated->key);
        return std::unexpected(malformed);
    }
    return manifest;
}

auto game_of(const finder::target& target) -> u32 {
    return target.steam_app;
}

auto fact_name(u64 key, std::span<const finder::fact_search> searches) -> std::string {
    const auto found = std::ranges::find_if(searches, [&](const finder::fact_search& search) {
        return kit::fact_name_hash(kit::dev_fact_seed, search.fact) == key;
    });
    return found == searches.end() ? std::format("{:#018x}", key) : std::string{found->fact};
}

auto hex_of(const crypto::digest& digest) -> std::string {
    std::string text;
    for (const std::byte part : digest) {
        text += std::format("{:02x}", static_cast<u8>(part));
    }
    return text;
}

}
