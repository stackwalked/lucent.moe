#pragma once

#include <span>
#include <string_view>

#include <lucent/kit/fact.hpp>
#include <lucent/probe/finder.hpp>

namespace lucent::finder {

// How the generator derives one declared fact: its name, kind and module index as the target's
// foreign layer declares them, and the finders that must agree on its value.
struct fact_search {
    std::string_view fact;
    kit::fact_kind kind = kit::fact_kind::value;
    // The index the target's game module table gives the module (kit::game_module::index).
    u8 module = 0;
    std::span<const probe::finder> finders;
};

}
