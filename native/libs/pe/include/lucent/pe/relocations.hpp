#pragma once

#include <vector>

#include <lucent/pe/image_view.hpp>

namespace lucent::pe {

// Where the image holds absolute 64-bit addresses: each must move by the distance between the base
// it was linked for and the base it gets. Padding entries are skipped; any other relocation type
// is unsupported, since x64 images use no other.
auto relocations_of(const image_view& image) -> result<std::vector<u32>>;

}
