#include <lucent/bundle/release_manifest.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <functional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

#include "wire.hpp"

// On the wire, little-endian, nothing aligned or padded:
//   version 1: u32 magic "LRM1", u16 version 1, u32 game (the Steam app), then the body;
//   version 2: u32 magic "LRM1", u16 version 2, u8 product size, product, the body, then
//     u32 feature count and per feature: u64 key, u8 tag size, tag.
//   The body: u32 fact count, then per fact: u64 key, u8 kind; u32 capability count, then per
//     capability: u64 key, u8 level, u32 member count, u64 keys.
// The magic names the format; the version field says which one. A change that isn't additive is
// a new version; the server keeps a decoder for each a live release uses.

namespace lucent::bundle {
namespace {

// "LRM1" as a little-endian u32.
constexpr u32 release_manifest_magic = 0x314d'524c;
constexpr u16 version_one = 1;
constexpr u16 version_two = 2;

// Sanity bounds on what the decoder accepts.
constexpr usize max_facts = usize{1} << 20U;
constexpr usize max_capabilities = usize{1} << 16U;
constexpr usize max_features = usize{1} << 16U;

// The smallest encodings, which bound a count by the bytes left before anything is reserved.
constexpr usize fact_size = 9;
constexpr usize capability_size = 21;
constexpr usize feature_size = 10;

constexpr error malformed{.code = error_code::malformed};

// What both versions carry the same way.
struct manifest_body {
    std::vector<manifest_entry> facts;
    std::vector<manifest_capability> capabilities;
};

auto is_known(capability_level level) -> bool {
    switch (level) {
    case capability_level::optional:
    case capability_level::core:
        return true;
    }
    return false;
}

auto is_strictly_sorted(std::span<const u64> keys) -> bool {
    return std::ranges::adjacent_find(keys, std::ranges::greater_equal{}) == keys.end();
}

auto has_fact(std::span<const manifest_entry> facts, u64 key) -> bool {
    return std::ranges::binary_search(facts, key, {}, &manifest_entry::key);
}

auto is_canonical(const manifest_capability& capability, std::span<const manifest_entry> facts)
    -> bool {
    return capability.key != 0
           && is_known(capability.level)
           && !capability.members.empty()
           && is_strictly_sorted(capability.members)
           && std::ranges::all_of(capability.members, [&](u64 member) {
                  return has_fact(facts, member);
              });
}

auto is_canonical(
    std::span<const manifest_entry> facts, std::span<const manifest_capability> capabilities
) -> bool {
    const auto fact_out_of_order =
        std::ranges::adjacent_find(facts, std::ranges::greater_equal{}, &manifest_entry::key);
    const auto capability_out_of_order = std::ranges::adjacent_find(
        capabilities, std::ranges::greater_equal{}, &manifest_capability::key
    );
    return fact_out_of_order == facts.end()
           && !std::ranges::contains(facts, u64{0}, &manifest_entry::key)
           && capability_out_of_order == capabilities.end()
           && std::ranges::all_of(capabilities, [&](const manifest_capability& each) {
                  return is_canonical(each, facts);
              });
}

auto is_product(std::string_view product) -> bool {
    return !product.empty()
           && product.size() <= max_product_size
           && std::ranges::all_of(product, [](char each) {
                  return (each >= 'a' && each <= 'z')
                         || (each >= '0' && each <= '9')
                         || each == '-';
              });
}

// The platform's FeatureTag: [a-z0-9][a-z0-9._-]{0,63}.
auto is_feature_tag(std::string_view tag) -> bool {
    const auto is_head = [](char each) {
        return (each >= 'a' && each <= 'z') || (each >= '0' && each <= '9');
    };
    return !tag.empty()
           && tag.size() <= max_feature_tag_size
           && is_head(tag.front())
           && std::ranges::all_of(tag, [&](char each) {
                  return is_head(each) || each == '.' || each == '_' || each == '-';
              });
}

auto is_canonical(std::span<const manifest_feature> features) -> bool {
    const auto out_of_order =
        std::ranges::adjacent_find(features, std::ranges::greater_equal{}, &manifest_feature::key);
    return out_of_order == features.end()
           && !std::ranges::contains(features, u64{0}, &manifest_feature::key)
           && std::ranges::all_of(features, [](const manifest_feature& each) {
                  return is_feature_tag(each.tag);
              });
}

auto is_canonical(const release_manifest_v2& manifest) -> bool {
    return is_product(manifest.product)
           && is_canonical(manifest.facts, manifest.capabilities)
           && is_canonical(manifest.features);
}

auto write_text(detail::writer& out, std::string_view text) -> void {
    out.write_u8(static_cast<u8>(text.size()));
    out.write_bytes(std::as_bytes(std::span{text}));
}

auto read_text(detail::reader& input) -> result<std::string> {
    const u8 size = LUCENT_TRY(input.read_u8());
    const std::span<const std::byte> taken = LUCENT_TRY(input.read_bytes(size));
    std::string text;
    for (const std::byte each : taken) {
        text.push_back(static_cast<char>(each));
    }
    return text;
}

auto write_body(
    detail::writer& out,
    std::span<const manifest_entry> facts,
    std::span<const manifest_capability> capabilities
) -> void {
    LUCENT_INVARIANT(is_canonical(facts, capabilities));
    LUCENT_INVARIANT(facts.size() <= max_facts);
    LUCENT_INVARIANT(capabilities.size() <= max_capabilities);
    out.write_u32(static_cast<u32>(facts.size()));
    for (const manifest_entry& fact : facts) {
        out.write_u64(fact.key);
        out.write_u8(fact.kind);
    }
    out.write_u32(static_cast<u32>(capabilities.size()));
    for (const manifest_capability& capability : capabilities) {
        out.write_u64(capability.key);
        out.write_u8(std::to_underlying(capability.level));
        out.write_u32(static_cast<u32>(capability.members.size()));
        for (const u64 member : capability.members) {
            out.write_u64(member);
        }
    }
}

auto read_count(detail::reader& input, usize limit) -> result<u32> {
    const u32 count = LUCENT_TRY(input.read_u32());
    if (count > limit) {
        return std::unexpected(malformed);
    }
    return count;
}

auto read_capability(detail::reader& input, usize fact_count) -> result<manifest_capability> {
    manifest_capability capability;
    capability.key = LUCENT_TRY(input.read_u64());
    const u8 level = LUCENT_TRY(input.read_u8());
    capability.level = static_cast<capability_level>(level);
    const u32 member_count = LUCENT_TRY(read_count(input, fact_count));
    capability.members.reserve(member_count);
    for (u32 index = 0; index < member_count; ++index) {
        capability.members.push_back(LUCENT_TRY(input.read_u64()));
    }
    return capability;
}

// Not checked for canonical order: the caller checks the whole manifest at once.
auto read_body(detail::reader& input, usize total_size) -> result<manifest_body> {
    manifest_body body;
    const u32 fact_count =
        LUCENT_TRY(read_count(input, std::min(max_facts, total_size / fact_size)));
    body.facts.reserve(fact_count);
    for (u32 index = 0; index < fact_count; ++index) {
        manifest_entry fact;
        fact.key = LUCENT_TRY(input.read_u64());
        fact.kind = LUCENT_TRY(input.read_u8());
        body.facts.push_back(fact);
    }
    const u32 capability_count =
        LUCENT_TRY(read_count(input, std::min(max_capabilities, total_size / capability_size)));
    body.capabilities.reserve(capability_count);
    for (u32 index = 0; index < capability_count; ++index) {
        body.capabilities.push_back(LUCENT_TRY(read_capability(input, fact_count)));
    }
    return body;
}

auto read_features(detail::reader& input, usize total_size)
    -> result<std::vector<manifest_feature>> {
    const u32 count =
        LUCENT_TRY(read_count(input, std::min(max_features, total_size / feature_size)));
    std::vector<manifest_feature> features;
    features.reserve(count);
    for (u32 index = 0; index < count; ++index) {
        manifest_feature feature;
        feature.key = LUCENT_TRY(input.read_u64());
        feature.tag = LUCENT_TRY(read_text(input));
        features.push_back(std::move(feature));
    }
    return features;
}

// The magic, then the version this decoder reads: anything else is version_mismatch.
auto read_header(detail::reader& input, u16 version) -> result<void> {
    if (LUCENT_TRY(input.read_u32()) != release_manifest_magic) {
        return std::unexpected(malformed);
    }
    if (LUCENT_TRY(input.read_u16()) != version) {
        return std::unexpected(error{.code = error_code::version_mismatch});
    }
    return {};
}

auto core_keys_of(std::span<const manifest_capability> capabilities) -> std::vector<u64> {
    std::vector<u64> keys;
    for (const manifest_capability& capability : capabilities) {
        if (capability.level == capability_level::core) {
            keys.insert(keys.end(), capability.members.begin(), capability.members.end());
        }
    }
    std::ranges::sort(keys);
    const auto [first, last] = std::ranges::unique(keys);
    keys.erase(first, last);
    return keys;
}

}

auto encode_release_manifest(const release_manifest& manifest) -> std::vector<std::byte> {
    detail::writer out;
    out.write_u32(release_manifest_magic);
    out.write_u16(version_one);
    out.write_u32(manifest.game);
    write_body(out, manifest.facts, manifest.capabilities);
    return out.take();
}

auto decode_release_manifest(std::span<const std::byte> bytes) -> result<release_manifest> {
    detail::reader input{bytes};
    LUCENT_TRY(read_header(input, version_one));
    const u32 game = LUCENT_TRY(input.read_u32());
    manifest_body body = LUCENT_TRY(read_body(input, bytes.size()));
    if (!input.is_at_end() || !is_canonical(body.facts, body.capabilities)) {
        return std::unexpected(malformed);
    }
    return release_manifest{
        .game = game,
        .facts = std::move(body.facts),
        .capabilities = std::move(body.capabilities),
    };
}

auto manifest_digest(const release_manifest& manifest) -> crypto::digest {
    return manifest_digest(manifest.facts);
}

auto core_fact_keys(const release_manifest& manifest) -> std::vector<u64> {
    return core_keys_of(manifest.capabilities);
}

auto encode_release_manifest_v2(const release_manifest_v2& manifest) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(manifest));
    LUCENT_INVARIANT(manifest.features.size() <= max_features);
    detail::writer out;
    out.write_u32(release_manifest_magic);
    out.write_u16(version_two);
    write_text(out, manifest.product);
    write_body(out, manifest.facts, manifest.capabilities);
    out.write_u32(static_cast<u32>(manifest.features.size()));
    for (const manifest_feature& feature : manifest.features) {
        out.write_u64(feature.key);
        write_text(out, feature.tag);
    }
    return out.take();
}

auto decode_release_manifest_v2(std::span<const std::byte> bytes) -> result<release_manifest_v2> {
    detail::reader input{bytes};
    LUCENT_TRY(read_header(input, version_two));
    std::string product = LUCENT_TRY(read_text(input));
    manifest_body body = LUCENT_TRY(read_body(input, bytes.size()));
    release_manifest_v2 manifest{
        .product = std::move(product),
        .facts = std::move(body.facts),
        .capabilities = std::move(body.capabilities),
        .features = LUCENT_TRY(read_features(input, bytes.size())),
    };
    if (!input.is_at_end() || !is_canonical(manifest)) {
        return std::unexpected(malformed);
    }
    return manifest;
}

auto manifest_digest(const release_manifest_v2& manifest) -> crypto::digest {
    return manifest_digest(manifest.facts);
}

auto core_fact_keys(const release_manifest_v2& manifest) -> std::vector<u64> {
    return core_keys_of(manifest.capabilities);
}

}
