#pragma once

#include <array>

#include <lucent/kit/game_module.hpp>

namespace lucent::cs2 {

// The game modules cs2's facts name, by the index a fact carries.
inline constexpr u8 client_module = 1;

inline constexpr std::array game_modules{
    kit::game_module{.index = client_module, .name = "client.dll"},
};

}
