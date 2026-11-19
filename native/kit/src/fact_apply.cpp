#include <lucent/kit/fact_apply.hpp>

#include <algorithm>
#include <expected>
#include <optional>
#include <span>
#include <tuple>
#include <utility>
#include <vector>

#include <lucent/bundle/bundle.hpp>
#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::kit {
namespace {

// Which module a linked fact belongs to, by key.
struct owner {
    u64 key = 0;
    u8 module = 0;
};

auto owners_of(std::span<const fact_record> records) -> std::vector<owner> {
    std::vector<owner> owners;
    owners.reserve(records.size());
    for (const fact_record& record : records) {
        if (record.key != 0) {
            owners.push_back(owner{.key = record.key, .module = record.module});
        }
    }
    std::ranges::sort(owners, {}, &owner::key);
    return owners;
}

auto owner_of(std::span<const owner> owners, u64 key) -> std::optional<u8> {
    const auto found = std::ranges::lower_bound(owners, key, {}, &owner::key);
    if (found == owners.end() || found->key != key) {
        return std::nullopt;
    }
    return found->module;
}

auto loaded_by_name(std::span<const loaded_module> modules, u64 name_hash) -> const loaded_module* {
    const auto found = std::ranges::find_if(modules, [&](const loaded_module& loaded) {
        return loaded.build.name_hash == name_hash;
    });
    return found == modules.end() ? nullptr : &*found;
}

auto judge(
    const bundle::delivered_set& set, const apply_request& request, const crypto::digest& manifest
) -> set_outcome {
    if (!bundle::verify(set, request.trusted)) {
        return set_outcome::unverified;
    }
    if (set.header.manifest_digest != manifest) {
        return set_outcome::other_manifest;
    }
    for (const bundle::module_key& wanted : set.header.modules) {
        const loaded_module* const loaded = loaded_by_name(request.modules, wanted.name_hash);
        if (loaded == nullptr) {
            return set_outcome::module_absent;
        }
        if (loaded->build != wanted) {
            return set_outcome::other_build;
        }
    }
    return set_outcome::applied;
}

// The module indices a set vouches for: those of the loaded modules it's keyed by.
auto vouched_modules(const bundle::delivered_set& set, std::span<const loaded_module> modules)
    -> std::vector<u8> {
    std::vector<u8> indices;
    for (const loaded_module& loaded : modules) {
        // any_of, not find: MSVC STL 14.51's vectorized find refuses 16-byte elements at compile
        // time.
        const bool is_keyed = std::ranges::any_of(
            set.header.modules, [&](const bundle::module_key& key) { return key == loaded.build; }
        );
        if (is_keyed) {
            indices.push_back(loaded.image.index);
        }
    }
    return indices;
}

struct set_values {
    std::vector<fact_value> values;
    u32 misplaced = 0;
};

// A value for a fact this image doesn't link passes through, for resolve to count as unknown.
auto values_of(
    const bundle::delivered_set& set,
    std::span<const owner> owners,
    std::span<const loaded_module> modules
) -> set_values {
    const std::vector<u8> vouched = vouched_modules(set, modules);
    set_values taken;
    for (const bundle::delivered_entry& given : set.entries) {
        const std::optional<u64> value = bundle::literal_value(given.value);
        if (!value) {
            continue;
        }
        const std::optional<u8> module = owner_of(owners, given.value.key);
        if (module && std::ranges::find(vouched, *module) == vouched.end()) {
            ++taken.misplaced;
            continue;
        }
        taken.values.push_back(fact_value{.key = given.value.key, .value = *value});
    }
    return taken;
}

}

auto manifest_of(std::span<const fact_record> records) -> crypto::digest {
    std::vector<bundle::manifest_entry> entries;
    entries.reserve(records.size());
    for (const fact_record& record : records) {
        if (record.key != 0) {
            entries.push_back(
                bundle::manifest_entry{.key = record.key, .kind = std::to_underlying(record.kind)}
            );
        }
    }
    std::ranges::sort(entries, {}, &bundle::manifest_entry::key);
    return bundle::manifest_digest(entries);
}

auto apply(const apply_request& request) -> result<apply_report> {
    std::vector<module_image> images;
    images.reserve(request.modules.size());
    for (const loaded_module& loaded : request.modules) {
        images.push_back(loaded.image);
    }
    const result<std::vector<bundle::delivered_set>> decoded =
        bundle::decode_bundle(request.bundle);
    if (!decoded) {
        std::ignore = resolve(request.records, {}, images);
        return std::unexpected(decoded.error());
    }
    const crypto::digest manifest = manifest_of(request.records);
    const std::vector<owner> owners = owners_of(request.records);
    apply_report report;
    std::vector<fact_value> values;
    for (const bundle::delivered_set& set : *decoded) {
        const set_outcome outcome = judge(set, request, manifest);
        report.sets.push_back(outcome);
        if (outcome != set_outcome::applied) {
            continue;
        }
        const set_values taken = values_of(set, owners, request.modules);
        values.insert(values.end(), taken.values.begin(), taken.values.end());
        report.misplaced += taken.misplaced;
    }
    report.facts = resolve(request.records, values, images);
    return report;
}

}
