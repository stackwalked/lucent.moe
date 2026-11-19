#pragma once

#include <string>
#include <vector>

#include <lucent/cs2-domains/foreign/entities.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::cs2 {

// An entity as the game names it across frames: its index in the entity list (low 15 bits) and the
// serial that index was given, so a freed and reused index isn't the same entity.
enum class entity_handle : u32 {};

enum class team : u8 { none, terrorists, counter_terrorists };

// A point or extent in the game's world space, in its units.
struct vec3 {
    f32 x = 0.0F;
    f32 y = 0.0F;
    f32 z = 0.0F;
};

// One connected player as of one frame.
struct player {
    entity_handle controller{};
    entity_handle pawn{};
    // UTF-8 as the game holds it; empty when the game's copy wasn't a terminated name.
    std::string name;
    team side = team::none;
    i32 health = 0;
    bool is_alive = false;
    bool is_local = false;
    vec3 origin;
    // The collision box around origin, relative to it.
    vec3 mins;
    vec3 maxs;
};

// The players as one frame left them: plain values, nothing pointing into the game. A part drawing
// features read on the render thread.
struct world {
    using backing = foreign::entities;

    std::vector<player> players;
};

// Reads every player off the entity list. A player any of whose values fails to read or doesn't
// hold up is left out; no entity system (the main menu) is no players.
auto read_world(const kit::read_access<foreign::entities>& game) -> world;

}
