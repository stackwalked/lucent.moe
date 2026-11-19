#pragma once

#include <cstddef>
#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::integrity {

// The bytes a range of the image holds once it is mapped at `base` with its base relocations
// applied: what a hash challenge over that range should cover. A loader's other writes (the
// import address table, the load config's guard pointers) are not reproduced, so a challenge
// must not cover them.
auto expected_bytes(const pe::image_view& file, u64 base, pe::rva_range range)
    -> result<std::vector<std::byte>>;

}
