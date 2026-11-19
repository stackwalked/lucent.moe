#include <array>

#include <lucent/cs2-modules/game_modules.hpp>
#include <lucent/kit/fact.hpp>

// The camera as client.dll keeps it. Nothing reads it yet, hence `used` (see entities.cpp).
namespace lucent::cs2::foreign {

// A row-major 4x4 matrix of floats.
using matrix = std::array<std::array<f32, 4>, 4>;

// The world-to-projection matrix the current view is built from, the first of an array indexed by
// split-screen slot.
LUCENT_FACT kit::fact::global<matrix> view_matrix [[gnu::used]]{"view_matrix", client_module};

}
