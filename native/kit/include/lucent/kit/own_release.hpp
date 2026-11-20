#pragma once

#include <optional>

#include <lucent/wire/ids.hpp>

namespace lucent::kit {

// The release this module was built as: a Release build compiles in the tree's LUCENT_RELEASE_ID,
// the id its container carries too. Dev builds belong to no release.
auto own_release() -> std::optional<wire::release_id>;

}
