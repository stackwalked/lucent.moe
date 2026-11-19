#include <lucent/cs2-domains/world.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <limits>
#include <span>
#include <string_view>
#include <tuple>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/kit/read_access.hpp>

// client.dll laid out in bytes: the entity system, one chunk of identities, two controllers and
// their pawns, with made-up offsets resolved into the real facts. What the world must refuse is
// what the game hands it mid-change: a freed index reused, a half-written position.

namespace lucent::cs2 {
namespace {

constexpr u64 image_base = 0x1000'0000;
constexpr isize image_size = 0x4000;

constexpr isize system_rva = 0x10;
constexpr isize local_rva = 0x18;
constexpr isize system_at = 0x100;
constexpr isize chunks_offset = 0x10;
constexpr isize chunk_at = 0x400;
constexpr isize identity_size = 0x40;
constexpr isize identity_entity_offset = 0x0;
constexpr isize identity_handle_offset = 0x10;

constexpr isize controller_size = 0x400;
constexpr isize pawn_handle_offset = 0x100;
constexpr isize name_offset = 0x120;

constexpr isize entity_size = 0x300;
constexpr isize health_offset = 0x10;
constexpr isize life_state_offset = 0x14;
constexpr isize team_offset = 0x15;
constexpr isize scene_node_offset = 0x18;
constexpr isize collision_offset = 0x20;

constexpr isize scene_node_size = 0x80;
constexpr isize origin_offset = 0x40;
constexpr isize collision_size = 0x40;
constexpr isize mins_offset = 0x10;
constexpr isize maxs_offset = 0x1c;

// A player slot's controller, its pawn at an index past the slots, and their parts.
struct laid_out_player {
    u32 slot = 0;
    u32 serial = 0;
    u32 pawn_index = 0;
    isize controller_at = 0;
    isize pawn_at = 0;
    isize node_at = 0;
    isize collision_at = 0;
    std::string_view name;
    u8 team = 0;
};

constexpr laid_out_player first{
    .slot = 1,
    .serial = 3,
    .pawn_index = 100,
    .controller_at = 0x2000,
    .pawn_at = 0x2800,
    .node_at = 0x3000,
    .collision_at = 0x3200,
    .name = "alpha",
    .team = 2,
};
constexpr laid_out_player second{
    .slot = 2,
    .serial = 5,
    .pawn_index = 101,
    .controller_at = 0x2400,
    .pawn_at = 0x2c00,
    .node_at = 0x3100,
    .collision_at = 0x3300,
    .name = "bravo",
    .team = 3,
};

using image = std::array<std::byte, image_size>;

// One overload per type laid out: domain code, tests included, declares no templates.
auto put_bytes(image& bytes, isize offset, std::span<const std::byte> value) -> void {
    std::ranges::copy(value, bytes.begin() + offset);
}

auto put(image& bytes, isize offset, u64 value) -> void {
    put_bytes(bytes, offset, std::as_bytes(std::span{&value, 1}));
}

auto put(image& bytes, isize offset, u32 value) -> void {
    put_bytes(bytes, offset, std::as_bytes(std::span{&value, 1}));
}

auto put(image& bytes, isize offset, i32 value) -> void {
    put_bytes(bytes, offset, std::as_bytes(std::span{&value, 1}));
}

auto put(image& bytes, isize offset, u8 value) -> void {
    put_bytes(bytes, offset, std::as_bytes(std::span{&value, 1}));
}

auto put(image& bytes, isize offset, foreign::vector value) -> void {
    put_bytes(bytes, offset, std::as_bytes(std::span{&value, 1}));
}

auto address_of(isize offset) -> u64 {
    return image_base + static_cast<u64>(offset);
}

auto identity_at(u32 index) -> isize {
    return chunk_at + (static_cast<isize>(index) * identity_size);
}

auto handle_of(u32 index, u32 serial) -> u32 {
    return index | (serial << 15U);
}

// An identity in the chunk, holding the entity at entity_at under index and serial.
struct laid_out_identity {
    u32 index = 0;
    u32 serial = 0;
    isize entity_at = 0;
};

auto put_identity(image& bytes, const laid_out_identity& laid) -> void {
    put(bytes, identity_at(laid.index) + identity_entity_offset, address_of(laid.entity_at));
    put(bytes,
        identity_at(laid.index) + identity_handle_offset,
        handle_of(laid.index, laid.serial));
}

auto put_player(image& bytes, const laid_out_player& laid) -> void {
    put_identity(
        bytes, {.index = laid.slot, .serial = laid.serial, .entity_at = laid.controller_at}
    );
    put_identity(
        bytes, {.index = laid.pawn_index, .serial = laid.serial + 1, .entity_at = laid.pawn_at}
    );
    put(bytes,
        laid.controller_at + pawn_handle_offset,
        handle_of(laid.pawn_index, laid.serial + 1));
    std::ranges::copy(
        std::as_bytes(std::span{laid.name}), bytes.begin() + laid.controller_at + name_offset
    );
    put(bytes, laid.pawn_at + health_offset, i32{87});
    put(bytes, laid.pawn_at + life_state_offset, u8{0});
    put(bytes, laid.pawn_at + team_offset, laid.team);
    put(bytes, laid.pawn_at + scene_node_offset, address_of(laid.node_at));
    put(bytes, laid.pawn_at + collision_offset, address_of(laid.collision_at));
    put(bytes, laid.node_at + origin_offset, foreign::vector{.x = 100.0F, .y = -20.0F, .z = 8.0F});
    put(bytes,
        laid.collision_at + mins_offset,
        foreign::vector{.x = -16.0F, .y = -16.0F, .z = 0.0F});
    put(bytes,
        laid.collision_at + maxs_offset,
        foreign::vector{.x = 16.0F, .y = 16.0F, .z = 72.0F});
}

// Two players, the first the local one.
auto laid_out_game() -> image {
    image bytes{};
    put(bytes, system_rva, address_of(system_at));
    put(bytes, local_rva, address_of(first.controller_at));
    put(bytes, system_at + chunks_offset, address_of(chunk_at));
    put_player(bytes, first);
    put_player(bytes, second);
    return bytes;
}

auto resolve_entities() -> void {
    const std::array values{
        kit::fact_value{.key = foreign::entity_system.record().key, .value = system_rva},
        kit::fact_value{.key = foreign::entity_list_chunks.record().key, .value = chunks_offset},
        kit::fact_value{.key = foreign::entity_identity_size.record().key, .value = identity_size},
        kit::fact_value{
            .key = foreign::identity_entity.record().key,
            .value = identity_entity_offset,
        },
        kit::fact_value{
            .key = foreign::identity_handle.record().key,
            .value = identity_handle_offset,
        },
        kit::fact_value{.key = foreign::local_player_controller.record().key, .value = local_rva},
        kit::fact_value{.key = foreign::entity_size.record().key, .value = entity_size},
        kit::fact_value{.key = foreign::entity_health.record().key, .value = health_offset},
        kit::fact_value{.key = foreign::entity_life_state.record().key, .value = life_state_offset},
        kit::fact_value{.key = foreign::entity_team.record().key, .value = team_offset},
        kit::fact_value{.key = foreign::entity_scene_node.record().key, .value = scene_node_offset},
        kit::fact_value{.key = foreign::entity_collision.record().key, .value = collision_offset},
        kit::fact_value{.key = foreign::scene_node_size.record().key, .value = scene_node_size},
        kit::fact_value{.key = foreign::scene_node_abs_origin.record().key, .value = origin_offset},
        kit::fact_value{.key = foreign::collision_size.record().key, .value = collision_size},
        kit::fact_value{.key = foreign::collision_mins.record().key, .value = mins_offset},
        kit::fact_value{.key = foreign::collision_maxs.record().key, .value = maxs_offset},
        kit::fact_value{
            .key = foreign::player_controller_size.record().key,
            .value = controller_size,
        },
        kit::fact_value{
            .key = foreign::player_controller_pawn.record().key,
            .value = pawn_handle_offset,
        },
        kit::fact_value{.key = foreign::player_controller_name.record().key, .value = name_offset},
    };
    const std::array modules{
        kit::module_image{
            .index = client_module,
            .base = image_base,
            .size = image_size,
            .sections =
                {
                    kit::image_section{
                        .rva = 0,
                        .size = image_size,
                        .is_executable = false,
                        .is_writable = true,
                    },
                },
            .time_date_stamp = 0,
            .size_of_image = image_size,
        },
    };
    std::ignore = kit::resolve(kit::linked_fact_records(), values, modules);
}

// The values were copied, not computed, so they match bit for bit.
auto is_at(vec3 read, vec3 laid) -> bool {
    return std::bit_cast<std::array<u32, 3>>(read) == std::bit_cast<std::array<u32, 3>>(laid);
}

auto world_of(image& bytes) -> world {
    resolve_entities();
    REQUIRE(kit::is_available(foreign::entities{}));
    const kit::read_access<foreign::entities> game{
        lucent::foreign::memory_source::from_bytes(image_base, bytes),
    };
    return read_world(game);
}

}

TEST_CASE("the world holds every player the entity list reaches, the local one marked") {
    image bytes = laid_out_game();

    const world seen = world_of(bytes);

    REQUIRE(seen.players.size() == 2);
    const player& local = seen.players.at(0);
    CHECK(local.name == "alpha");
    CHECK(local.is_local);
    CHECK(local.side == team::terrorists);
    CHECK(local.health == 87);
    CHECK(local.is_alive);
    CHECK(local.controller == entity_handle{handle_of(first.slot, first.serial)});
    CHECK(local.pawn == entity_handle{handle_of(first.pawn_index, first.serial + 1)});
    CHECK(is_at(local.origin, {.x = 100.0F, .y = -20.0F, .z = 8.0F}));
    CHECK(is_at(local.mins, {.x = -16.0F, .y = -16.0F, .z = 0.0F}));
    CHECK(is_at(local.maxs, {.x = 16.0F, .y = 16.0F, .z = 72.0F}));
    const player& other = seen.players.at(1);
    CHECK(other.name == "bravo");
    CHECK_FALSE(other.is_local);
    CHECK(other.side == team::counter_terrorists);
}

TEST_CASE("a pawn handle whose index was freed and reused leaves its player out") {
    image bytes = laid_out_game();
    // The second pawn's index now holds a newer entity under a later serial.
    put(bytes,
        identity_at(second.pawn_index) + identity_handle_offset,
        handle_of(second.pawn_index, second.serial + 2));

    const world seen = world_of(bytes);

    REQUIRE(seen.players.size() == 1);
    CHECK(seen.players.front().name == "alpha");
}

TEST_CASE("a player whose position or box doesn't hold up is left out") {
    image bytes = laid_out_game();
    put(bytes,
        first.node_at + origin_offset,
        foreign::vector{.x = std::numeric_limits<f32>::quiet_NaN(), .y = 0.0F, .z = 0.0F});
    put(bytes,
        second.collision_at + mins_offset,
        foreign::vector{.x = 32.0F, .y = -16.0F, .z = 0.0F});

    CHECK(world_of(bytes).players.empty());
}

TEST_CASE("a dead player stays in the world, no longer alive") {
    image bytes = laid_out_game();
    put(bytes, second.pawn_at + health_offset, i32{0});
    put(bytes, second.pawn_at + life_state_offset, u8{2});

    const world seen = world_of(bytes);

    REQUIRE(seen.players.size() == 2);
    CHECK_FALSE(seen.players.at(1).is_alive);
}

TEST_CASE("a name the game didn't terminate reads as no name, the player kept") {
    image bytes = laid_out_game();
    std::ranges::fill(
        std::span{bytes}.subspan(static_cast<usize>(second.controller_at + name_offset), 128),
        std::byte{'x'}
    );

    const world seen = world_of(bytes);

    REQUIRE(seen.players.size() == 2);
    CHECK(seen.players.at(1).name.empty());
}

TEST_CASE("without an entity system, at the main menu, the world has no players") {
    image bytes = laid_out_game();
    put(bytes, system_rva, u64{0});

    CHECK(world_of(bytes).players.empty());
}

}
