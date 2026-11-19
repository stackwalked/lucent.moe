#include <lucent/cs2-domains/world.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <string>
#include <utility>

#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::cs2 {
namespace {

using access = kit::read_access<foreign::entities>;
using identity_ptr = lucent::foreign::foreign_ptr<foreign::entity_identity>;
using instance_ptr = lucent::foreign::foreign_ptr<foreign::entity_instance>;

// A handle's low 15 bits are its entity's index: bits 9 and up pick the chunk, the low 9 the
// identity in it. All ones is no entity.
// build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44)
// found: every inlined handle lookup: `and ecx, 0x7fff; shr rcx, 9` for the chunk, `and ecx,
// 0x1ff` for the identity, `cmp eax, -1` first; the finders of entity_identity_size and
// entity_list_chunks match only that shape, so a change leaves the capability unavailable
// breaks: handles resolve to the wrong identities, which the serial check then refuses
constexpr u32 index_mask = 0x7fff;
constexpr u32 chunk_shift = 9;
constexpr u32 in_chunk_mask = 0x1ff;
constexpr u32 no_entity = 0xffff'ffff;

// Player controllers sit at entity indices 1 to 64, one per player slot.
// build: cs2 1.41.9.9
// found: Source 2 reserves the first entity indices after the world (0) for the player slots,
// at most 64 in cs2; old lucent and every public cs2 reader walk 1..64 the same way
// breaks: a server with more slots loses the players past 64; an entity of another class in a
// slot reads as a controller, which the pawn's serial check and the value ranges below catch
// almost always (hypothesis: no class check until vtable facts reach capabilities)
constexpr isize first_player_index = 1;
constexpr isize last_player_index = 64;

// CS2's team numbers and Source's life state for a living entity.
// build: cs2 1.41.9.9
// found: Source's TEAM_TERRORIST 2 and TEAM_CT 3, LIFE_ALIVE 0 (the SDK's shareddefs.h), unchanged
// in cs2's schema enums
// breaks: teams swapped or unknown, or the living drawn as dead
constexpr u8 terrorist_team = 2;
constexpr u8 counter_terrorist_team = 3;
constexpr u8 spectator_team = 1;
constexpr u8 alive = 0;

// What a value read from the game must fall in to be believed: far wider than the game uses.
constexpr i32 max_health = 10'000;
constexpr f32 max_coordinate = 65'536.0F;
constexpr f32 max_extent = 1'024.0F;

auto identity_at(const access& game, const foreign::entity_chunks& chunks, u32 index)
    -> identity_ptr {
    const u32 chunk = (index & index_mask) >> chunk_shift;
    // Never past the list: index_mask >> chunk_shift is the last chunk.
    const identity_ptr first = chunks.at(chunk);
    return game.element<foreign::entity_identity_size>(first, isize{index & in_chunk_mask});
}

// The entity an identity holds, with the handle it holds it under.
struct held_entity {
    instance_ptr entity;
    u32 handle = no_entity;
};

auto held_by(const access& game, identity_ptr identity) -> std::optional<held_entity> {
    const result<u32> handle = game.read<foreign::identity_handle>(identity);
    const result<instance_ptr> entity = game.read<foreign::identity_entity>(identity);
    if (!handle || !entity || lucent::foreign::is_null(*entity)) {
        return std::nullopt;
    }
    return held_entity{.entity = *entity, .handle = *handle};
}

// The entity a handle names, while its identity still holds that handle: a serial that moved on
// means the entity was freed and the index reused.
auto entity_of(const access& game, const foreign::entity_chunks& chunks, u32 handle)
    -> std::optional<instance_ptr> {
    if (handle == no_entity) {
        return std::nullopt;
    }
    const std::optional<held_entity> held = held_by(game, identity_at(game, chunks, handle));
    if (!held || held->handle != handle) {
        return std::nullopt;
    }
    return held->entity;
}

// Bases at offset 0 (foreign/entities.hpp).
auto as_controller(instance_ptr entity)
    -> lucent::foreign::foreign_ptr<foreign::player_controller> {
    return {.address = entity.address};
}

auto as_entity(instance_ptr entity) -> lucent::foreign::foreign_ptr<foreign::base_entity> {
    return {.address = entity.address};
}

auto is_finite(foreign::vector read) -> bool {
    return std::isfinite(read.x) && std::isfinite(read.y) && std::isfinite(read.z);
}

auto to_vec3(foreign::vector read) -> vec3 {
    return {.x = read.x, .y = read.y, .z = read.z};
}

auto is_position(foreign::vector read) -> bool {
    return is_finite(read)
           && std::abs(read.x) <= max_coordinate
           && std::abs(read.y) <= max_coordinate
           && std::abs(read.z) <= max_coordinate;
}

auto is_extent(foreign::vector read) -> bool {
    return is_finite(read)
           && std::abs(read.x) <= max_extent
           && std::abs(read.y) <= max_extent
           && std::abs(read.z) <= max_extent;
}

auto team_of(u8 number) -> std::optional<team> {
    switch (number) {
    case terrorist_team:
        return team::terrorists;
    case counter_terrorist_team:
        return team::counter_terrorists;
    case 0:
    case spectator_team:
        return team::none;
    default:
        return std::nullopt;
    }
}

// The name up to its terminator; empty when the game's copy has none.
auto name_of(const std::array<char, 128>& held) -> std::string {
    const auto end = std::ranges::find(held, '\0');
    if (end == held.end()) {
        return {};
    }
    return std::string{held.begin(), end};
}

struct pawn_values {
    i32 health = 0;
    bool is_alive = false;
    team side = team::none;
    vec3 origin;
    vec3 mins;
    vec3 maxs;
};

auto box_of(const access& game, lucent::foreign::foreign_ptr<foreign::base_entity> pawn)
    -> std::optional<pawn_values> {
    const result<lucent::foreign::foreign_ptr<foreign::game_scene_node>> node =
        game.read<foreign::entity_scene_node>(pawn);
    const result<lucent::foreign::foreign_ptr<foreign::collision_property>> collision =
        game.read<foreign::entity_collision>(pawn);
    if (!node || !collision) {
        return std::nullopt;
    }
    const result<foreign::vector> origin = game.read<foreign::scene_node_abs_origin>(*node);
    const result<foreign::vector> mins = game.read<foreign::collision_mins>(*collision);
    const result<foreign::vector> maxs = game.read<foreign::collision_maxs>(*collision);
    if (!origin || !mins || !maxs) {
        return std::nullopt;
    }
    if (!is_position(*origin) || !is_extent(*mins) || !is_extent(*maxs)) {
        return std::nullopt;
    }
    if (mins->x > maxs->x || mins->y > maxs->y || mins->z > maxs->z) {
        return std::nullopt;
    }
    return pawn_values{
        .health = 0,
        .is_alive = false,
        .side = team::none,
        .origin = to_vec3(*origin),
        .mins = to_vec3(*mins),
        .maxs = to_vec3(*maxs),
    };
}

auto pawn_values_of(const access& game, lucent::foreign::foreign_ptr<foreign::base_entity> pawn)
    -> std::optional<pawn_values> {
    const result<i32> health = game.read<foreign::entity_health>(pawn);
    const result<u8> life_state = game.read<foreign::entity_life_state>(pawn);
    const result<u8> team_number = game.read<foreign::entity_team>(pawn);
    if (!health || !life_state || !team_number) {
        return std::nullopt;
    }
    const std::optional<team> side = team_of(*team_number);
    if (*health < 0 || *health > max_health || !side) {
        return std::nullopt;
    }
    const std::optional<pawn_values> box = box_of(game, pawn);
    if (!box) {
        return std::nullopt;
    }
    return pawn_values{
        .health = *health,
        .is_alive = *life_state == alive && *health > 0,
        .side = *side,
        .origin = box->origin,
        .mins = box->mins,
        .maxs = box->maxs,
    };
}

struct player_slot {
    const foreign::entity_chunks* chunks = nullptr;
    lucent::foreign::foreign_ptr<foreign::player_controller> local;
    u32 index = 0;
};

auto player_at(const access& game, const player_slot& slot) -> std::optional<player> {
    const std::optional<held_entity> held =
        held_by(game, identity_at(game, *slot.chunks, slot.index));
    if (!held || (held->handle & index_mask) != slot.index) {
        return std::nullopt;
    }
    const lucent::foreign::foreign_ptr<foreign::player_controller> controller =
        as_controller(held->entity);
    const result<u32> pawn_handle = game.read<foreign::player_controller_pawn>(controller);
    const result<std::array<char, 128>> name =
        game.read<foreign::player_controller_name>(controller);
    if (!pawn_handle || !name) {
        return std::nullopt;
    }
    const std::optional<instance_ptr> pawn = entity_of(game, *slot.chunks, *pawn_handle);
    if (!pawn) {
        return std::nullopt;
    }
    const std::optional<pawn_values> values = pawn_values_of(game, as_entity(*pawn));
    if (!values) {
        return std::nullopt;
    }
    return player{
        .controller = entity_handle{held->handle},
        .pawn = entity_handle{*pawn_handle},
        .name = name_of(*name),
        .side = values->side,
        .health = values->health,
        .is_alive = values->is_alive,
        .is_local = controller == slot.local,
        .origin = values->origin,
        .mins = values->mins,
        .maxs = values->maxs,
    };
}

}

auto read_world(const access& game) -> world {
    world seen;
    const result<lucent::foreign::foreign_ptr<foreign::game_entity_system>> system =
        game.read<foreign::entity_system>();
    if (!system || lucent::foreign::is_null(*system)) {
        return seen;
    }
    const result<foreign::entity_chunks> chunks = game.read<foreign::entity_list_chunks>(*system);
    if (!chunks) {
        return seen;
    }
    const result<lucent::foreign::foreign_ptr<foreign::player_controller>> local =
        game.read<foreign::local_player_controller>();
    player_slot slot{
        .chunks = &*chunks,
        .local = local.value_or(lucent::foreign::foreign_ptr<foreign::player_controller>{}),
        .index = 0,
    };
    for (isize index = first_player_index; index <= last_player_index; ++index) {
        slot.index = static_cast<u32>(index);
        if (std::optional<player> found = player_at(game, slot)) {
            seen.players.push_back(std::move(*found));
        }
    }
    return seen;
}

}
