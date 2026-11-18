#include <lucent/bundle/bundle.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

#include "format.hpp"
#include "merkle.hpp"
#include "wire.hpp"

namespace lucent::bundle {
namespace {

constexpr error malformed{.code = error_code::malformed};

auto leaves_of(const fact_set& full) -> std::vector<crypto::digest> {
    std::vector<crypto::digest> leaves;
    leaves.reserve(full.entries.size());
    for (const entry& stored : full.entries) {
        leaves.push_back(detail::leaf_hash(stored));
    }
    return leaves;
}

auto write_set(detail::writer& out, const delivered_set& set) -> void {
    out.write_bytes(signed_bytes(set.header));
    out.write_bytes(set.header.signature);
    out.write_u32(static_cast<u32>(set.entries.size()));
    for (const delivered_entry& given : set.entries) {
        out.write_u32(given.index);
        out.write_u64(given.value.key);
        out.write_u8(static_cast<u8>(given.value.tag));
        out.write_u8(static_cast<u8>(given.value.payload.size()));
        out.write_bytes(given.value.payload);
    }
    out.write_u32(static_cast<u32>(set.proof.size()));
    for (const crypto::digest& hash : set.proof) {
        out.write_bytes(hash);
    }
}

// The magic and format version every top-level structure starts with.
auto read_preamble(detail::reader& input, u32 magic) -> result<void> {
    if (LUCENT_TRY(input.read_u32()) != magic) {
        return std::unexpected(malformed);
    }
    if (LUCENT_TRY(input.read_u16()) != detail::format_version) {
        return std::unexpected(error{.code = error_code::version_mismatch});
    }
    return {};
}

auto read_module(detail::reader& input) -> result<module_key> {
    module_key module;
    module.name_hash = LUCENT_TRY(input.read_u64());
    module.time_date_stamp = LUCENT_TRY(input.read_u32());
    module.size_of_image = LUCENT_TRY(input.read_u32());
    return module;
}

// Sorted and unique; the count was read and bounded earlier, as the wire orders it.
auto read_modules(detail::reader& input, u16 count) -> result<std::vector<module_key>> {
    std::vector<module_key> modules;
    modules.reserve(count);
    for (u16 index = 0; index < count; ++index) {
        const module_key module = LUCENT_TRY(read_module(input));
        if (!modules.empty() && !(modules.back() < module)) {
            return std::unexpected(malformed);
        }
        modules.push_back(module);
    }
    return modules;
}

auto read_header(detail::reader& input) -> result<fact_set_header> {
    LUCENT_TRY(read_preamble(input, detail::fact_set_magic));
    const u16 module_count = LUCENT_TRY(input.read_u16());
    if (module_count == 0 || module_count > detail::max_modules) {
        return std::unexpected(malformed);
    }
    fact_set_header header;
    header.game = LUCENT_TRY(input.read_u32());
    header.revision = LUCENT_TRY(input.read_u32());
    header.modules = LUCENT_TRY(read_modules(input, module_count));
    header.finders_commit = LUCENT_TRY(input.read_array<20>());
    header.manifest_digest = LUCENT_TRY(input.read_array<crypto::digest_size>());
    header.entry_count = LUCENT_TRY(input.read_u32());
    if (header.entry_count > detail::max_entries) {
        return std::unexpected(malformed);
    }
    header.merkle_root = LUCENT_TRY(input.read_array<crypto::digest_size>());
    header.signature = LUCENT_TRY(input.read_array<crypto::signature_size>());
    return header;
}

auto read_entry(detail::reader& input) -> result<delivered_entry> {
    delivered_entry given;
    given.index = LUCENT_TRY(input.read_u32());
    given.value.key = LUCENT_TRY(input.read_u64());
    const u8 tag = LUCENT_TRY(input.read_u8());
    const u8 length = LUCENT_TRY(input.read_u8());
    // Version 1 knows literals only.
    if (tag != static_cast<u8>(payload_tag::literal) || length != detail::literal_size) {
        return std::unexpected(malformed);
    }
    given.value.tag = payload_tag::literal;
    const std::span<const std::byte> payload = LUCENT_TRY(input.read_bytes(length));
    given.value.payload.assign(payload.begin(), payload.end());
    return given;
}

auto read_set(detail::reader& input) -> result<delivered_set> {
    delivered_set set;
    set.header = LUCENT_TRY(read_header(input));
    const u32 present = LUCENT_TRY(input.read_u32());
    if (present > set.header.entry_count) {
        return std::unexpected(malformed);
    }
    set.entries.reserve(present);
    for (u32 count = 0; count < present; ++count) {
        delivered_entry given = LUCENT_TRY(read_entry(input));
        const bool is_in_order = set.entries.empty()
                                 || (set.entries.back().index < given.index
                                     && set.entries.back().value.key < given.value.key);
        if (given.index >= set.header.entry_count || !is_in_order) {
            return std::unexpected(malformed);
        }
        set.entries.push_back(std::move(given));
    }
    const u32 proof_count = LUCENT_TRY(input.read_u32());
    if (proof_count > set.header.entry_count + 1) {
        return std::unexpected(malformed);
    }
    for (u32 count = 0; count < proof_count; ++count) {
        set.proof.push_back(LUCENT_TRY(input.read_array<crypto::digest_size>()));
    }
    return set;
}

}

auto deliver(const fact_set& full, std::span<const u64> keys) -> delivered_set {
    delivered_set set{.header = full.header, .entries = {}, .proof = {}};
    std::vector<u32> present;
    for (u32 index = 0; const entry& stored : full.entries) {
        if (std::ranges::find(keys, stored.key) != keys.end()) {
            present.push_back(index);
            set.entries.push_back(delivered_entry{.index = index, .value = stored});
        }
        ++index;
    }
    set.proof = detail::proof_for(leaves_of(full), present);
    return set;
}

auto deliver_all(const fact_set& full) -> delivered_set {
    delivered_set set{.header = full.header, .entries = {}, .proof = {}};
    for (u32 index = 0; const entry& stored : full.entries) {
        set.entries.push_back(delivered_entry{.index = index, .value = stored});
        ++index;
    }
    return set;
}

auto encode_bundle(std::span<const delivered_set> sets) -> std::vector<std::byte> {
    LUCENT_INVARIANT(sets.size() <= detail::max_sets);
    detail::writer out;
    out.write_u32(detail::bundle_magic);
    out.write_u16(detail::format_version);
    out.write_u16(static_cast<u16>(sets.size()));
    for (const delivered_set& set : sets) {
        write_set(out, set);
    }
    return out.take();
}

auto decode_bundle(std::span<const std::byte> bytes) -> result<std::vector<delivered_set>> {
    detail::reader input{bytes};
    LUCENT_TRY(read_preamble(input, detail::bundle_magic));
    const u16 set_count = LUCENT_TRY(input.read_u16());
    if (set_count > detail::max_sets) {
        return std::unexpected(malformed);
    }
    std::vector<delivered_set> sets;
    sets.reserve(set_count);
    for (u16 index = 0; index < set_count; ++index) {
        sets.push_back(LUCENT_TRY(read_set(input)));
    }
    if (!input.is_at_end()) {
        return std::unexpected(malformed);
    }
    return sets;
}

auto verify(const delivered_set& set, std::span<const crypto::public_key> trusted) -> result<void> {
    const std::vector<std::byte> covered = signed_bytes(set.header);
    const bool is_signed = std::ranges::any_of(trusted, [&](const crypto::public_key& signer) {
        return crypto::verify(signer, covered, set.header.signature).has_value();
    });
    if (!is_signed) {
        return std::unexpected(malformed);
    }
    std::vector<detail::known_leaf> known;
    known.reserve(set.entries.size());
    for (const delivered_entry& given : set.entries) {
        known.push_back(
            detail::known_leaf{.index = given.index, .hash = detail::leaf_hash(given.value)}
        );
    }
    const crypto::digest root =
        LUCENT_TRY(detail::root_from(set.header.entry_count, known, set.proof));
    if (root != set.header.merkle_root) {
        return std::unexpected(malformed);
    }
    return {};
}

}
