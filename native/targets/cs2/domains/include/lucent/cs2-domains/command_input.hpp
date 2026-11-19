#pragma once

#include <vector>

#include <lucent/cs2-domains/command.hpp>
#include <lucent/cs2-domains/foreign/user_cmd.hpp>

namespace lucent::cs2 {

// The tick's command as the game built it from the player's input, before any stage wrote to it.
// Handed to features at createmove, on the game thread, for that tick.
struct command_input {
    using backing = foreign::user_command;

    // Counts the commands the domain has seen, one a tick.
    i64 tick = 0;
    game_command game;
    // The previous tick's requests that didn't go in, and why.
    std::vector<step_refusal> refusals;
};

}
