#pragma once

#include <cstddef>
#include <span>

#include <lucent/os/process.hpp>
#include <lucent/pe/image_view.hpp>

namespace lucent::manualmap::detail {

// Resolves every import of the image against modules in the target, loading any it lacks, and
// writes the addresses into the import slots of the local copy of the image.
auto bind_imports(
    const os::process& target, const pe::image_view& image, std::span<std::byte> local
) -> result<void>;

}
