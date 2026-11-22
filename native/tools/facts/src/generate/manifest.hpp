#pragma once

#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/bundle/release_manifest.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/feature_section.hpp>

namespace lucent::facts {

// What a built module links, as the linker wrote it into the file.
struct module_manifest {
    // Its fact section, gaps and kit's markers (key 0) left out. What the generator must cover,
    // kind for kind.
    std::vector<kit::fact_record> facts;
    // Its capability section, in section order.
    std::vector<kit::declared_capability> capabilities;
    // Its feature section, in section order: every feature the module wires.
    std::vector<kit::declared_feature> features;
};

auto manifest_of(const std::filesystem::path& module) -> result<module_manifest>;

// The release manifest the server is given for this module: its facts, each with the name hash of
// the game module the target's table maps its module index to, capabilities and features sorted,
// for the target's product. Malformed, with an error printed, when two facts, capabilities or
// features share a key, a capability names a fact the module doesn't link, or a fact's module
// index isn't in the target's table.
auto release_manifest_of(const module_manifest& linked, const finder::target& target)
    -> result<bundle::release_manifest_v3>;

// The product a target's release manifest names: its id in products/*.toml, which is the target's
// name (the cs2 target builds the cs2 product).
auto product_of(const finder::target& target) -> std::string_view;

// The fact a key names, as the target's searches spell it; the key itself for a fact none searches.
auto fact_name(u64 key, std::span<const finder::fact_search> searches) -> std::string;

auto hex_of(const crypto::digest& digest) -> std::string;

}
