#pragma once

#include <span>
#include <string_view>
#include <vector>

#include <lucent/finders/fact_search.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::finders {

// Everything the generator knows about one game, as that game's finders library describes it.
struct target {
    // The generator's --target; LUCENT_<NAME>, uppercased, overrides where the game is installed.
    std::string_view name;
    // The Steam app whose install holds the game.
    u32 steam_app = 0;
    // Where the game modules sit under the install, backslash-separated.
    std::string_view module_directory;
    // The module table the target's own module uses, so module indices mean the same on both
    // sides.
    std::span<const kit::game_module> modules;
    std::vector<fact_search> searches;
};

}
