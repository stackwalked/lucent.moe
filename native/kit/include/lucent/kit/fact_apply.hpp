#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/crypto/crypto.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::kit {

// What became of one fact set in a bundle.
enum class set_outcome : u8 {
    applied,
    // Not signed by a trusted key, or an entry isn't provably under the signed root.
    unverified,
    // Made for another manifest: another release, or a build with other features linked.
    other_manifest,
    // A module it's keyed by is loaded as another build.
    other_build,
    // A module it's keyed by isn't loaded (yet).
    module_absent,
};

struct apply_request {
    std::span<const std::byte> bundle;
    // The keys a fact set may be signed with.
    std::span<const crypto::public_key> trusted;
    // The facts to resolve: linked_fact_records(), outside tests.
    std::span<const fact_record> records;
    std::span<const loaded_module> modules;
};

struct apply_report {
    // One per set, in the bundle's order.
    std::vector<set_outcome> sets;
    // Values in applied sets for facts of a module the set isn't keyed by; dropped, since the
    // set says nothing about that module's build.
    u32 misplaced = 0;
    resolve_report facts;
};

// The manifest digest of these facts: what a fact set must have been made for to apply here.
auto manifest_of(std::span<const fact_record> records) -> crypto::digest;

// Resolves the facts from the bundle's sets that pass every check, in order: the signature and
// Merkle proof against the trusted keys, the manifest digest against the records, and each module
// build key against the loaded modules. A set that fails one contributes nothing. Every fact is
// reset first, whatever happens, so a refused set leaves its facts unresolved. A bundle that
// doesn't decode fails as malformed or version_mismatch, with every fact unresolved.
auto apply(const apply_request& request) -> result<apply_report>;

}
