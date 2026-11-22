#pragma once

#include <filesystem>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/os/modules.hpp>
#include <lucent/os/process.hpp>

// The games the loader starts products in, and the module builds a start reports. Compiled in for
// now: products/*.toml has no field for a game's process, and only cs2 is a module product.

namespace lucent::loader {

struct game_product {
    // The product id, as products/<id>.toml names it.
    std::string_view id;
    std::string_view executable;
    // How many directories above the executable's own the game's install root is: every module
    // loaded from under it is the game's, and its build goes into the start.
    // build: cs2 1.41.9.9, cs2.exe in game/bin/win64, client.dll in game/csgo/bin/win64,
    //        engine2.dll beside cs2.exe
    // found: the installed game's layout
    // breaks: game modules go unreported, their facts unserved, and the start is refused or
    //         its features unavailable
    u32 root_levels = 0;
    // A module the game loads once it's far enough along to start in: before it, the modules a
    // start would report are only the launcher's few.
    std::string_view ready_module;
};

inline constexpr game_product cs2{
    .id = "cs2",
    .executable = "cs2.exe",
    .root_levels = 2,
    .ready_module = "client.dll",
};

auto find_game_product(std::string_view id) -> std::optional<game_product>;

// The game's running process, opened for loading code into it; not_found while it isn't running.
auto open_game(const game_product& product) -> result<os::process>;

// Whether the game has loaded its ready module yet.
auto is_ready(const game_product& product, const os::process& game) -> bool;

// The modules loaded from under the game's install root.
auto game_modules(const game_product& product, std::span<const os::remote_module> loaded)
    -> std::vector<os::remote_module>;

// Each game module's build key, read from its headers in the process, sorted and unique as a
// start request carries them; more than wire::max_start_modules is refused as unsupported.
auto module_builds(const os::process& game, std::span<const os::remote_module> modules)
    -> result<std::vector<bundle::module_key>>;

}
