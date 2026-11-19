#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <vector>

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::facts {

// What a built module links, as the linker wrote it into the file.
struct module_manifest {
    // Its fact section, gaps and kit's markers (key 0) left out. What the generator must cover,
    // kind for kind.
    std::vector<kit::fact_record> facts;
    // Its capability section, in section order.
    std::vector<kit::declared_capability> capabilities;
};

auto manifest_of(const std::filesystem::path& module) -> result<module_manifest>;

// The release manifest the server is given for this module: its facts and capabilities sorted,
// for the game the target names. Malformed, with an error printed, when two facts or two
// capabilities share a key, or a capability names a fact the module doesn't link.
auto release_manifest_of(const module_manifest& linked, u32 game)
    -> result<bundle::release_manifest>;

// The game a target's release manifest names: its Steam app, the one numeric identity every target
// has today.
auto game_of(const finder::target& target) -> u32;

// The fact a key names, as the target's searches spell it; the key itself for a fact none searches.
auto fact_name(u64 key, std::span<const finder::fact_search> searches) -> std::string;

auto hex_of(const crypto::digest& digest) -> std::string;

}
