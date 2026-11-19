#pragma once

#include <algorithm>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/fact_resolve.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::kit {

// A game module a target's facts name, under the index those facts carry (fact_record::module).
struct game_module {
    u8 index = 0;
    std::string_view name;
};

// Module names hash with their own seed, so a module's name hash never equals a fact's key.
inline constexpr u64 module_name_seed = 0x6c75'6365'6e74'6d6f;

// The name half of a module build key: fact_name_hash over the name in ASCII lowercase, since
// Windows compares module names case-insensitively. Whatever writes fact sets (devkey, the
// generator, the server) hashes names exactly this way.
constexpr auto module_name_hash(std::string_view name) -> u64 {
    std::string lowered{name};
    std::ranges::transform(lowered, lowered.begin(), [](char letter) {
        return letter >= 'A' && letter <= 'Z' ? static_cast<char>(letter - 'A' + 'a') : letter;
    });
    return fact_name_hash(module_name_seed, lowered);
}

// A module image's build key, read the same way from its file and from its loaded headers.
auto module_build_of(const pe::image_view& image, std::string_view name)
    -> result<bundle::module_key>;

// A game module loaded in this process, under its build key.
struct loaded_module {
    bundle::module_key build;
    module_image image;
};

// Those of the known modules this process has loaded right now; one not loaded yet is left out,
// as is one whose headers don't read.
auto loaded_game_modules(std::span<const game_module> known) -> std::vector<loaded_module>;

}
