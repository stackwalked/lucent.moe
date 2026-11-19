#include <lucent/cs2-finders/target.hpp>

#include <string_view>
#include <utility>
#include <vector>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/finders/fact_search.hpp>
#include <lucent/finders/target.hpp>

#include "searches.hpp"

namespace lucent::finders {

// build: Steam's cs2 install, 2026-11 (app 730, Steam build 26772654)
// found: steamapps\appmanifest_730.acf; client.dll in game\csgo\bin\win64
// breaks: the install or the module isn't found; ingest fails and says where it looked
constexpr u32 cs2_app = 730;
constexpr std::string_view cs2_module_directory = R"(game\csgo\bin\win64)";

auto cs2_target() -> target {
    std::vector<fact_search> searches;
    searches.append_range(entity_searches());
    searches.append_range(view_searches());
    return target{
        .name = "cs2",
        .steam_app = cs2_app,
        .module_directory = cs2_module_directory,
        .modules = cs2::game_modules,
        .searches = std::move(searches),
    };
}

}
