#pragma once

#include <cstddef>
#include <span>
#include <vector>

#include <lucent/bundle/bundle.hpp>
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

struct late_request {
    // The facts the waiting sets were verified against.
    std::span<const fact_record> records;
    // Every known module loaded now, those loaded at boot included.
    std::span<const loaded_module> modules;
};

// A bundle that arrived after the start (release builds: the data route's answer for a module
// loaded late).
struct admit_request {
    std::span<const std::byte> bundle;
    std::span<const crypto::public_key> trusted;
    std::span<const fact_record> records;
};

struct late_report {
    // One per set decided now (applied, or other_build), in the bundle's order.
    std::vector<set_outcome> sets;
    u32 misplaced = 0;
    // Over the facts of the modules the applied sets are keyed by.
    resolve_report facts;
};

struct apply_report;

// The sets apply or admit verified and found made for this manifest, but keyed by a module that
// wasn't loaded yet. Only those two add to them, so applying one later needs only its module keys
// checked.
class waiting_sets final {
public:
    waiting_sets() = default;
    waiting_sets(const waiting_sets&) = delete ("a set applies once");
    auto operator=(const waiting_sets&) -> waiting_sets& = delete ("a set applies once");
    waiting_sets(waiting_sets&&) noexcept = default;
    auto operator=(waiting_sets&&) noexcept -> waiting_sets& = default;
    ~waiting_sets() = default;

    auto is_empty() const -> bool;

    // Applies each set whose modules have all loaded now, if their builds match the set's keys,
    // and drops it either way; a set still waiting on a module stays. Resolves with resolve_late,
    // so other threads may read facts meanwhile. One thread at a time.
    auto apply_loaded(const late_request& request) -> late_report;

    // Adds the bundle's sets that are signed by a trusted key with every entry under the signed
    // root, and made for this manifest; the rest it drops. Resolves nothing: apply_loaded applies
    // them once their modules have loaded. A bundle that doesn't decode adds nothing, and fails as
    // apply's does. One thread at a time.
    auto admit(const admit_request& request) -> result<void>;

private:
    friend auto apply(const apply_request& request) -> result<apply_report>;

    explicit waiting_sets(std::vector<bundle::delivered_set> sets);

    std::vector<bundle::delivered_set> m_sets;
};

struct apply_report {
    // One per set, in the bundle's order.
    std::vector<set_outcome> sets;
    // Values in applied sets for facts of a module the set isn't keyed by; dropped, since the
    // set says nothing about that module's build.
    u32 misplaced = 0;
    resolve_report facts;
    // The sets whose outcome is module_absent, for when their modules load.
    waiting_sets waiting;
};

// The manifest digest of these facts: what a fact set must have been made for to apply here.
auto manifest_of(std::span<const fact_record> records) -> crypto::digest;

// Resolves the facts from the bundle's sets that pass every check, in order: the signature and
// Merkle proof against the trusted keys, the manifest digest against the records, and each module
// build key against the loaded modules. A set that fails one contributes nothing. Every fact is
// reset first, whatever happens, so a refused set leaves its facts unresolved. A bundle that
// doesn't decode fails as malformed or version_mismatch, with every fact unresolved. Before
// anything reads facts: it rewrites every one.
auto apply(const apply_request& request) -> result<apply_report>;

}
