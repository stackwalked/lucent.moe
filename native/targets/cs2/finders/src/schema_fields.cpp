#include <array>
#include <span>
#include <string_view>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/probe/finder.hpp>
#include <lucent/source2-probe/schema.hpp>

#include "searches.hpp"

// What a box around each player, with a name, reads: from the controller, the pawn handle and the
// name; from the pawn, health, life state, team, its scene node's absolute origin and its
// collision bounds for the box's height. m_hPlayerPawn rather than CBasePlayerController's m_hPawn:
// the latter is the observer pawn while the player is dead.
// Each type is SchemaSystem's name for the field's declared type; the fact's T must mirror it.
// build: client.dll TimeDateStamp 0x6afe3e44, SizeOfImage 0x298d000 (cs2 1.41.9.9): every field
// below read offline and identical on 1.41.9.2, 1.41.9.7 and 1.41.9.8
// found: engines/source2/probe's schema reader; research/kb/source2/schema-registration.md
// breaks: a field renamed or retyped: none, and the generator says which
namespace lucent::finder {
namespace {

constexpr std::array health_finders{source2::schema<"C_BaseEntity", "m_iHealth", "int32">()};
constexpr std::array life_state_finders{source2::schema<"C_BaseEntity", "m_lifeState", "uint8">()};
constexpr std::array team_finders{source2::schema<"C_BaseEntity", "m_iTeamNum", "uint8">()};
constexpr std::array scene_node_finders{
    source2::schema<"C_BaseEntity", "m_pGameSceneNode", "CGameSceneNode*">(),
};
constexpr std::array collision_finders{
    source2::schema<"C_BaseEntity", "m_pCollision", "CCollisionProperty*">(),
};
constexpr std::array entity_size_finders{source2::schema_size<"C_BaseEntity">()};

// The node's position in world space; VectorWS is three float32s.
constexpr std::array abs_origin_finders{
    source2::schema<"CGameSceneNode", "m_vecAbsOrigin", "VectorWS">(),
};
constexpr std::array scene_node_size_finders{source2::schema_size<"CGameSceneNode">()};

constexpr std::array mins_finders{source2::schema<"CCollisionProperty", "m_vecMins", "Vector">()};
constexpr std::array maxs_finders{source2::schema<"CCollisionProperty", "m_vecMaxs", "Vector">()};
constexpr std::array collision_size_finders{source2::schema_size<"CCollisionProperty">()};

constexpr std::array player_pawn_finders{
    source2::schema<"CCSPlayerController", "m_hPlayerPawn", "CHandle< C_CSPlayerPawn >">(),
};
constexpr std::array player_name_finders{
    source2::schema<"CBasePlayerController", "m_iszPlayerName", "char[128]">(),
};
constexpr std::array controller_size_finders{source2::schema_size<"CCSPlayerController">()};

constexpr auto field(std::string_view fact, std::span<const probe::finder> finders) -> fact_search {
    return fact_search{
        .fact = fact,
        .kind = kit::fact_kind::field,
        .module = cs2::client_module,
        .finders = finders,
    };
}

constexpr auto size(std::string_view fact, std::span<const probe::finder> finders) -> fact_search {
    return fact_search{
        .fact = fact,
        .kind = kit::fact_kind::value,
        .module = cs2::client_module,
        .finders = finders,
    };
}

constexpr std::array searches{
    field("entity_health", health_finders),
    field("entity_life_state", life_state_finders),
    field("entity_team", team_finders),
    field("entity_scene_node", scene_node_finders),
    field("entity_collision", collision_finders),
    size("entity_size", entity_size_finders),
    field("scene_node_abs_origin", abs_origin_finders),
    size("scene_node_size", scene_node_size_finders),
    field("collision_mins", mins_finders),
    field("collision_maxs", maxs_finders),
    size("collision_size", collision_size_finders),
    field("player_controller_pawn", player_pawn_finders),
    field("player_controller_name", player_name_finders),
    size("player_controller_size", controller_size_finders),
};

}

auto schema_searches() -> std::span<const fact_search> {
    return searches;
}

}
