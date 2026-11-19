#include "targets/named_modules.hpp"

#include <algorithm>
#include <span>
#include <vector>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::facts {

auto modules_named(std::span<const kit::fact_record> facts, std::span<const kit::game_module> table)
    -> std::vector<kit::game_module> {
    std::vector<kit::game_module> named;
    for (const kit::game_module& game : table) {
        if (std::ranges::contains(facts, game.index, &kit::fact_record::module)) {
            named.push_back(game);
        }
    }
    return named;
}

}
