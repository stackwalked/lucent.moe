#pragma once

#include <array>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// The entity list as client.dll keeps it, and what the world reads from each player on it. Their
// finders are in targets/cs2/finders: the list's in entities.cpp, the schema fields' in
// schema_fields.cpp.
namespace lucent::cs2::foreign {

// Mirrors, never read whole. C_CSPlayerPawn and CCSPlayerController derive from C_BaseEntity, which
// derives from CEntityInstance, each base at offset 0 (a single chain in the schema), so an
// instance's address is its entity's and its controller's.
struct game_entity_system;
struct entity_identity;
struct entity_instance;
struct base_entity;
struct player_controller;
struct game_scene_node;
struct collision_property;

// Schema's Vector and VectorWS: three float32s.
struct vector {
    f32 x = 0.0F;
    f32 y = 0.0F;
    f32 z = 0.0F;
};

// The entity list's chunks of identities, a 512-identity chunk per entry, up to the 0x7fff index a
// handle holds.
// build: client.dll 1.41.9.9 (TimeDateStamp 0x6afe3e44)
// found: every handle lookup bounds the chunk with `sar ecx, 9; cmp ecx, 0x3f; ja`, and
// identity_size's finders match only `and 0x1ff` chunks
// breaks: a longer list reads short, and handles past it resolve to nothing
inline constexpr isize entity_chunk_count = 64;
using entity_chunks = std::array<lucent::foreign::foreign_ptr<entity_identity>, entity_chunk_count>;

// client.dll's pointer to its CGameEntitySystem.
LUCENT_FACT kit::fact::global<game_entity_system*> entity_system{
    "entity_system",
    client_module,
};

// The chunk pointers inside CGameEntitySystem (its CConcreteEntityList).
LUCENT_FACT kit::fact::field<game_entity_system, entity_chunks> entity_list_chunks{
    "entity_list_chunks",
    client_module,
};

// How far apart a chunk's CEntityIdentity records are.
LUCENT_FACT kit::fact::value<i32> entity_identity_size{
    "entity_identity_size",
    client_module,
    {.min = 0x40, .max = 0x100},
};

// The identity's entity, and the handle it was last given: index and serial.
LUCENT_FACT kit::fact::field<entity_identity, entity_instance*> identity_entity{
    "identity_entity",
    client_module,
};
LUCENT_FACT kit::fact::field<entity_identity, u32> identity_handle{
    "identity_handle",
    client_module,
};

// The local player's controller, the first of an array indexed by split-screen slot.
LUCENT_FACT kit::fact::global<player_controller*> local_player_controller{
    "local_player_controller",
    client_module,
};

// C_BaseEntity, as a pawn holds it.
LUCENT_FACT kit::fact::value<i32> entity_size{
    "entity_size",
    client_module,
    {.min = 0x100, .max = 0x4000},
};
LUCENT_FACT kit::fact::field<base_entity, i32> entity_health{
    "entity_health",
    client_module,
    "entity_size",
};
LUCENT_FACT kit::fact::field<base_entity, u8> entity_life_state{
    "entity_life_state",
    client_module,
    "entity_size",
};
LUCENT_FACT kit::fact::field<base_entity, u8> entity_team{
    "entity_team",
    client_module,
    "entity_size",
};
LUCENT_FACT kit::fact::field<base_entity, game_scene_node*> entity_scene_node{
    "entity_scene_node",
    client_module,
    "entity_size",
};
LUCENT_FACT kit::fact::field<base_entity, collision_property*> entity_collision{
    "entity_collision",
    client_module,
    "entity_size",
};

// CGameSceneNode's position in world space.
LUCENT_FACT kit::fact::value<i32> scene_node_size{
    "scene_node_size",
    client_module,
    {.min = 0x40, .max = 0x1000},
};
LUCENT_FACT kit::fact::field<game_scene_node, vector> scene_node_abs_origin{
    "scene_node_abs_origin",
    client_module,
    "scene_node_size",
};

// CCollisionProperty's bounds, relative to the entity's origin.
LUCENT_FACT kit::fact::value<i32> collision_size{
    "collision_size",
    client_module,
    {.min = 0x20, .max = 0x1000},
};
LUCENT_FACT kit::fact::field<collision_property, vector> collision_mins{
    "collision_mins",
    client_module,
    "collision_size",
};
LUCENT_FACT kit::fact::field<collision_property, vector> collision_maxs{
    "collision_maxs",
    client_module,
    "collision_size",
};

// CCSPlayerController: its pawn's handle, and the player's name (char[128], NUL-terminated by the
// game).
LUCENT_FACT kit::fact::value<i32> player_controller_size{
    "player_controller_size",
    client_module,
    {.min = 0x200, .max = 0x4000},
};
LUCENT_FACT kit::fact::field<player_controller, u32> player_controller_pawn{
    "player_controller_pawn",
    client_module,
    "player_controller_size",
};
LUCENT_FACT kit::fact::field<player_controller, std::array<char, 128>> player_controller_name{
    "player_controller_name",
    client_module,
    "player_controller_size",
};

// Walking the entity list to the players and reading each one's box and name. One capability
// rather than the list's and the schema's apart: the world reads all of it every frame, and a
// view names one capability as its backing. Optional until the product decides what's core.
using entities = kit::capability<
    entity_system,
    entity_list_chunks,
    entity_identity_size,
    identity_entity,
    identity_handle,
    local_player_controller,
    entity_size,
    entity_health,
    entity_life_state,
    entity_team,
    entity_scene_node,
    entity_collision,
    scene_node_size,
    scene_node_abs_origin,
    collision_size,
    collision_mins,
    collision_maxs,
    player_controller_size,
    player_controller_pawn,
    player_controller_name>;
LUCENT_CAPABILITY kit::capability_record<entities> entities_record [[gnu::used]]{
    "entities",
    kit::capability_level::optional,
};

}
