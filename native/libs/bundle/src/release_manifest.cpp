#include <lucent/bundle/release_manifest.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <functional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

#include "wire.hpp"

// Version 1 on the wire, little-endian, nothing aligned or padded:
//   u32 magic "LRM1", u16 version, u32 game,
//   u32 fact count, then per fact: u64 key, u8 kind;
//   u32 capability count, then per capability: u64 key, u8 level, u32 member count, u64 keys.
// A change that isn't additive is a new version; the server keeps a decoder for each a live
// release uses.

namespace lucent::bundle {
namespace {

// "LRM1" as a little-endian u32.
constexpr u32 release_manifest_magic = 0x314d'524c;
constexpr u16 release_manifest_version = 1;

// Sanity bounds on what the decoder accepts.
constexpr usize max_facts = usize{1} << 20U;
constexpr usize max_capabilities = usize{1} << 16U;

// The smallest encodings, which bound a count by the bytes left before anything is reserved.
constexpr usize fact_size = 9;
constexpr usize capability_size = 21;

constexpr error malformed{.code = error_code::malformed};

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

auto is_canonical(const release_manifest& manifest) -> bool {
    const auto fact_out_of_order = std::ranges::adjacent_find(
        manifest.facts, std::ranges::greater_equal{}, &manifest_entry::key
    );
    const auto capability_out_of_order = std::ranges::adjacent_find(
        manifest.capabilities, std::ranges::greater_equal{}, &manifest_capability::key
    );
    return fact_out_of_order == manifest.facts.end()
           && !std::ranges::contains(manifest.facts, u64{0}, &manifest_entry::key)
           && capability_out_of_order == manifest.capabilities.end()
           && std::ranges::all_of(manifest.capabilities, [&](const manifest_capability& each) {
                  return is_canonical(each, manifest.facts);
              });
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

}

auto encode_release_manifest(const release_manifest& manifest) -> std::vector<std::byte> {
    LUCENT_INVARIANT(is_canonical(manifest));
    LUCENT_INVARIANT(manifest.facts.size() <= max_facts);
    LUCENT_INVARIANT(manifest.capabilities.size() <= max_capabilities);
    detail::writer out;
    out.write_u32(release_manifest_magic);
    out.write_u16(release_manifest_version);
    out.write_u32(manifest.game);
    out.write_u32(static_cast<u32>(manifest.facts.size()));
    for (const manifest_entry& fact : manifest.facts) {
        out.write_u64(fact.key);
        out.write_u8(fact.kind);
    }
    out.write_u32(static_cast<u32>(manifest.capabilities.size()));
    for (const manifest_capability& capability : manifest.capabilities) {
        out.write_u64(capability.key);
        out.write_u8(std::to_underlying(capability.level));
        out.write_u32(static_cast<u32>(capability.members.size()));
        for (const u64 member : capability.members) {
            out.write_u64(member);
        }
    }
    return out.take();
}

auto decode_release_manifest(std::span<const std::byte> bytes) -> result<release_manifest> {
    detail::reader input{bytes};
    if (LUCENT_TRY(input.read_u32()) != release_manifest_magic) {
        return std::unexpected(malformed);
    }
    if (LUCENT_TRY(input.read_u16()) != release_manifest_version) {
        return std::unexpected(error{.code = error_code::version_mismatch});
    }
    release_manifest manifest;
    manifest.game = LUCENT_TRY(input.read_u32());
    const u32 fact_count =
        LUCENT_TRY(read_count(input, std::min(max_facts, bytes.size() / fact_size)));
    manifest.facts.reserve(fact_count);
    for (u32 index = 0; index < fact_count; ++index) {
        manifest_entry fact;
        fact.key = LUCENT_TRY(input.read_u64());
        fact.kind = LUCENT_TRY(input.read_u8());
        manifest.facts.push_back(fact);
    }
    const u32 capability_count =
        LUCENT_TRY(read_count(input, std::min(max_capabilities, bytes.size() / capability_size)));
    manifest.capabilities.reserve(capability_count);
    for (u32 index = 0; index < capability_count; ++index) {
        manifest.capabilities.push_back(LUCENT_TRY(read_capability(input, fact_count)));
    }
    if (!input.is_at_end() || !is_canonical(manifest)) {
        return std::unexpected(malformed);
    }
    return manifest;
}

auto manifest_digest(const release_manifest& manifest) -> crypto::digest {
    return manifest_digest(manifest.facts);
}

auto core_fact_keys(const release_manifest& manifest) -> std::vector<u64> {
    std::vector<u64> keys;
    for (const manifest_capability& capability : manifest.capabilities) {
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
