#pragma once

#include <cstddef>
#include <filesystem>
#include <string>
#include <vector>

#include <lucent/bundle/fact_set.hpp>
#include <lucent/crypto/crypto.hpp>

namespace lucent::devkey {

// A fact's value by the name it's declared with: an address kind's RVA in its module, a slot's
// index, a field's offset, or a value.
struct named_value {
    std::string name;
    u64 value = 0;
};

struct dev_bundle_request {
    // Our module's file, whose fact section is the manifest the set is made for.
    std::filesystem::path module;
    // The game module's file, whose build key the set is keyed by.
    std::filesystem::path game_module;
    std::vector<named_value> values;
};

struct dev_bundle {
    std::vector<std::byte> bytes;
    bundle::module_key build;
    usize manifest_size = 0;
};

// One fact set, signed and delivered whole, the way the generator's will be once it exists. Fails
// as not_found when a name isn't a fact the module links: a set holding it would apply nothing.
auto make_dev_bundle(const dev_bundle_request& request, const crypto::signing_key& signer)
    -> result<dev_bundle>;

}
