#include <lucent/bundle/fact_set.hpp>

#include <algorithm>
#include <cstddef>
#include <optional>
#include <span>
#include <utility>
#include <vector>

#include <lucent/crypto/crypto.hpp>

#include "format.hpp"
#include "merkle.hpp"
#include "wire.hpp"

namespace lucent::bundle {

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters): declared and explained in fact_set.hpp.
auto literal(u64 key, u64 value) -> entry {
    detail::writer bytes;
    bytes.write_u64(value);
    return entry{.key = key, .tag = payload_tag::literal, .payload = bytes.take()};
}

auto literal_value(const entry& stored) -> std::optional<u64> {
    if (stored.tag != payload_tag::literal || stored.payload.size() != sizeof(u64)) {
        return std::nullopt;
    }
    detail::reader bytes{stored.payload};
    const result<u64> value = bytes.read_u64();
    return value ? std::optional<u64>{*value} : std::nullopt;
}

auto manifest_digest(std::span<const manifest_entry> entries) -> crypto::digest {
    detail::writer bytes;
    for (const manifest_entry& listed : entries) {
        bytes.write_u64(listed.key);
        bytes.write_u8(listed.kind);
    }
    return crypto::hash(bytes.bytes());
}

auto signed_bytes(const fact_set_header& header) -> std::vector<std::byte> {
    detail::writer bytes;
    bytes.write_u32(detail::fact_set_magic);
    bytes.write_u16(detail::format_version);
    bytes.write_u16(static_cast<u16>(header.modules.size()));
    bytes.write_u32(header.game);
    bytes.write_u32(header.revision);
    for (const module_key& module : header.modules) {
        bytes.write_u64(module.name_hash);
        bytes.write_u32(module.time_date_stamp);
        bytes.write_u32(module.size_of_image);
    }
    bytes.write_bytes(header.finders_commit);
    bytes.write_bytes(header.manifest_digest);
    bytes.write_u32(header.entry_count);
    bytes.write_bytes(header.merkle_root);
    return bytes.take();
}

auto sign_fact_set(
    fact_set_header header, std::vector<entry> entries, const crypto::signing_key& signer
) -> fact_set {
    std::ranges::sort(entries, {}, &entry::key);
    const bool has_duplicate =
        std::ranges::adjacent_find(entries, {}, &entry::key) != entries.end();
    LUCENT_INVARIANT(!has_duplicate);
    LUCENT_INVARIANT(entries.size() <= detail::max_entries);
    LUCENT_INVARIANT(!header.modules.empty() && header.modules.size() <= detail::max_modules);
    std::ranges::sort(header.modules);

    std::vector<crypto::digest> leaves;
    leaves.reserve(entries.size());
    for (const entry& stored : entries) {
        leaves.push_back(detail::leaf_hash(stored));
    }
    header.entry_count = static_cast<u32>(entries.size());
    header.merkle_root = detail::tree_root(leaves);
    header.signature = signer.sign(signed_bytes(header));
    return fact_set{.header = std::move(header), .entries = std::move(entries)};
}

}
