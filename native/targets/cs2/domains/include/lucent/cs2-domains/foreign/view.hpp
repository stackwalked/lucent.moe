#pragma once

#include <array>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

// The camera as client.dll keeps it. Its finder is in targets/cs2/finders/src/view.cpp.
namespace lucent::cs2::foreign {

// A row-major 4x4 matrix of floats.
using matrix = std::array<std::array<f32, 4>, 4>;

// The world-to-projection matrix the current view is built from, the first of an array indexed by
// split-screen slot.
LUCENT_FACT kit::fact::global<matrix> view_matrix{"view_matrix", client_module};

// Projecting world positions to the screen. Optional until the product decides what's core.
using view = kit::capability<view_matrix>;
LUCENT_CAPABILITY kit::capability_record<view> view_record
    [[gnu::used]]{"view", kit::capability_level::optional};

}
