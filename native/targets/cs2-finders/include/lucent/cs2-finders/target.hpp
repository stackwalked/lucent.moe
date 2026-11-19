#pragma once

#include <lucent/finders/target.hpp>

namespace lucent::finders {

// Counter-Strike 2: Steam app 730, its modules under game\csgo\bin\win64, and every fact the
// cs2 module links, searched by subsystem.
auto cs2_target() -> target;

}
