#pragma once

#include <span>
#include <vector>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::facts {

// The game modules a built module's facts name, in the target's table order: the modules the
// update-day pipeline ingests, and no others. An index the table doesn't hold names no module;
// generate reports its facts.
auto modules_named(std::span<const kit::fact_record> facts, std::span<const kit::game_module> table)
    -> std::vector<kit::game_module>;

}
