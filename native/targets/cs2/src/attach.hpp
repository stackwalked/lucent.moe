#pragma once

#include <array>
#include <memory>

#include <lucent/kit/game_module.hpp>
#include <lucent/kit/lifecycle.hpp>

namespace lucent::cs2 {

// The game modules cs2's facts name, by the index a fact carries.
inline constexpr u8 client_module = 1;

inline constexpr std::array game_modules{
    kit::game_module{.index = client_module, .name = "client.dll"},
};

// The cs2 module's attach, run by kit's lifecycle thread.
auto attach() -> result<std::unique_ptr<kit::attachment>>;

}
