#include <cstddef>
#include <optional>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/match.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/wire/ids.hpp>
#include <lucent/wire/release_seal.hpp>

#include "store/saved_state.hpp"
#include "update/decision.hpp"

namespace lucent::loader {
namespace {

auto code_key() -> crypto::signing_key {
    crypto::seed material{};
    material.fill(std::byte{7});
    return crypto::signing_key::from_seed(material);
}

auto release_of(u8 fill) -> wire::release_id {
    wire::release_id release;
    release.bytes.fill(std::byte{fill});
    return release;
}

struct seal_spec {
    u64 number = 5;
    wire::release_id release = release_of(1);
    wire::channel chosen = wire::channel::alpha;
    std::string_view product = loader_product;
};

auto loader_seal(const seal_spec& spec, const crypto::signing_key& signer)
    -> std::vector<std::byte> {
    const wire::release_seal unsigned_seal{
        .product = std::string{spec.product},
        .chosen = spec.chosen,
        .number = spec.number,
        .release = spec.release,
        .boot_info_version = 5,
        .artifacts =
            {
                wire::release_artifact{.kind = wire::artifact_kind::loader, .digest = {}},
                wire::release_artifact{.kind = wire::artifact_kind::host, .digest = {}},
            },
        .signature = {},
    };
    return wire::encode_release_seal(wire::sign_release_seal(unsigned_seal, signer));
}

auto decided(const std::vector<std::byte>& seal, std::optional<wire::release_id> own, u64 highest)
    -> result<update_decision> {
    return decide_update(
        update_inputs{
            .seal = seal,
            .code_key = code_key().public_part(),
            .chosen = wire::channel::alpha,
            .own = own,
            .highest_seen = highest,
        }
    );
}

enum class decision_kind : u8 { up_to_date, update_needed, rollback_refused };

// What a decision came to, flattened so a test can compare it.
struct decision_facts {
    decision_kind kind;
    u64 number;
    u64 highest;
};

auto facts_of(const update_decision& decided) -> decision_facts {
    return match(
        decided,
        [](const up_to_date& same) {
            return decision_facts{
                .kind = decision_kind::up_to_date,
                .number = same.seal.number,
                .highest = 0,
            };
        },
        [](const update_needed& newer) {
            return decision_facts{
                .kind = decision_kind::update_needed,
                .number = newer.seal.number,
                .highest = 0,
            };
        },
        [](const rollback_refused& rollback) {
            return decision_facts{
                .kind = decision_kind::rollback_refused,
                .number = rollback.served,
                .highest = rollback.highest,
            };
        }
    );
}

TEST_CASE("the release served is up to date when it is this build's") {
    const std::vector<std::byte> seal = loader_seal({.number = 5}, code_key());
    const result<update_decision> decision = decided(seal, release_of(1), 5);
    REQUIRE(decision);
    REQUIRE(facts_of(*decision).kind == decision_kind::up_to_date);
    REQUIRE(facts_of(*decision).number == 5);
}

TEST_CASE("another release served is an update") {
    const result<update_decision> decision =
        decided(loader_seal({.number = 6}, code_key()), release_of(2), 5);
    REQUIRE(decision);
    REQUIRE(facts_of(*decision).kind == decision_kind::update_needed);
    REQUIRE(facts_of(*decision).number == 6);
}

TEST_CASE("a dev build, which has no release, always sees an update") {
    const std::vector<std::byte> seal = loader_seal({.number = 5}, code_key());
    const result<update_decision> decision = decided(seal, std::nullopt, 0);
    REQUIRE(decision);
    REQUIRE(facts_of(*decision).kind == decision_kind::update_needed);
}

TEST_CASE("a seal numbered below one seen before is refused, even for this build's own release") {
    const result<update_decision> decision =
        decided(loader_seal({.number = 4}, code_key()), release_of(1), 5);
    REQUIRE(decision);
    const decision_facts facts = facts_of(*decision);
    REQUIRE(facts.kind == decision_kind::rollback_refused);
    REQUIRE(facts.number == 4);
    REQUIRE(facts.highest == 5);
}

TEST_CASE("a seal the code key didn't sign, or for another channel or product, is not acted on") {
    crypto::seed other{};
    other.fill(std::byte{8});
    const crypto::signing_key stranger = crypto::signing_key::from_seed(other);
    REQUIRE_FALSE(decided(loader_seal({}, stranger), release_of(1), 0));
    REQUIRE_FALSE(
        decided(loader_seal({.chosen = wire::channel::stable}, code_key()), release_of(1), 0)
    );
    REQUIRE_FALSE(decided(loader_seal({.product = "cs2"}, code_key()), release_of(1), 0));
}

TEST_CASE("the saved state round-trips, the highest seals seen per product and channel with it") {
    saved_state state{
        .refresh_token = "lrt_abc",
        .is_enrolled = true,
        .chosen = wire::channel::debug,
        .highest_loader_seal = {1, 2, 3},
        .highest_module_seal = {},
    };
    raise_highest_seal(state, wire::channel::alpha, 9);
    raise_highest_seal(state, wire::channel::alpha, 4);
    REQUIRE(highest_seal_of(state, wire::channel::alpha) == 9);
    raise_module_seal(state, "cs2", wire::channel::stable, 12);
    raise_module_seal(state, "cs2", wire::channel::stable, 3);
    raise_module_seal(state, "osu", wire::channel::alpha, 1);
    REQUIRE(highest_module_seal_of(state, "cs2", wire::channel::stable) == 12);
    REQUIRE(highest_module_seal_of(state, "cs2", wire::channel::alpha) == 0);
    REQUIRE(highest_module_seal_of(state, "tf2", wire::channel::stable) == 0);
    const result<saved_state> decoded = decode_saved_state(encode_saved_state(state));
    REQUIRE(decoded);
    REQUIRE(*decoded == state);
}

TEST_CASE("a saved state with anything after it, or another version, doesn't load") {
    std::vector<std::byte> bytes = encode_saved_state(saved_state{});
    bytes.push_back(std::byte{0});
    REQUIRE_FALSE(decode_saved_state(bytes));
    bytes = encode_saved_state(saved_state{});
    bytes.front() = std::byte{2};
    REQUIRE(decode_saved_state(bytes).error().code == error_code::version_mismatch);
}

}
}
