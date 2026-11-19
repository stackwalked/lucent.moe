#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/kit/fact.hpp>

// The entity list as client.dll keeps it. Nothing reads these yet, hence `used`: the compiler emits
// an inline variable only where something names it, and an unemitted fact is missing from the
// section and so from the manifest. Their finders are in targets/cs2/finders.
namespace lucent::cs2::foreign {

struct game_entity_system;
struct player_controller;

// client.dll's pointer to its CGameEntitySystem.
LUCENT_FACT kit::fact::global<game_entity_system*> entity_system [[gnu::used]]{
    "entity_system",
    client_module,
};

// The local player's controller, the first of an array indexed by split-screen slot.
LUCENT_FACT kit::fact::global<player_controller*> local_player_controller [[gnu::used]]{
    "local_player_controller",
    client_module,
};

// How far apart a chunk's CEntityIdentity records are.
LUCENT_FACT kit::fact::value<i32> entity_identity_size [[gnu::used]]{
    "entity_identity_size",
    client_module,
    {.min = 0x40, .max = 0x100},
};

}
