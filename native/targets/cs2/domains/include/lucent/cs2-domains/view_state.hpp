#pragma once

#include <lucent/cs2-domains/foreign/input.hpp>
#include <lucent/cs2-domains/mouse_model.hpp>

namespace lucent::cs2 {

// The view as the last frame left it, and what a count turns it by. Handed to features at
// createmove, on the game thread, for that tick.
struct view_state {
    using backing = foreign::view_angles;

    heading now;
    count_size per_count;
    // The command tick it was read at.
    i64 tick = 0;
};

}
