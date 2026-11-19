#pragma once

namespace lucent::kit {

// Whether this is a dev build: the Debug configuration, as kit's CMakeLists defines it. Code that
// must leave nothing in a release image sits in a discarded `if constexpr (is_dev_build)` branch:
// it is never instantiated, so neither it nor its string literals are emitted.
inline constexpr bool is_dev_build = LUCENT_KIT_DEV_BUILD != 0;

}
