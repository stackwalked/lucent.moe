#pragma once

#include <filesystem>
#include <string>
#include <string_view>

namespace lucent::facts {

// An installed game, with Steam's label for its build: for people reading the report, never for
// selecting facts. The label is empty when the install was given by hand.
struct game_install {
    std::filesystem::path directory;
    std::string build_id;
};

// The target's game where LUCENT_<TARGET> (uppercased) says, or else in whichever Steam library
// holds the app, as the Steam client installed for this user lists its libraries.
auto find_install(std::string_view target, u32 app) -> result<game_install>;

// The module file in that directory under the install.
auto module_path(const game_install& install, std::string_view directory, std::string_view name)
    -> result<std::filesystem::path>;

}
