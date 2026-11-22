#pragma once

#include "app/options.hpp"

namespace lucent::loader {

// The loader end to end: sign in if needed, update itself if it isn't the release served, enroll
// the PC if it isn't, wait for the game, start the product in it, relay its session until it
// ends. Returns the process's exit code; everything the member needs to know is printed.
auto run(const options& chosen) -> i32;

}
