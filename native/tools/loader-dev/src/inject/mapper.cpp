#include "inject/mapper.hpp"

#include <cstddef>
#include <expected>
#include <span>

#include <lucent/manualmap/map.hpp>
#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

auto map_module(const os::process& target, std::span<const std::byte> file)
    -> result<mapped_module> {
    manualmap::mapped image = LUCENT_TRY(manualmap::map(target, file));
    const result<void> attached = manualmap::attach(target, image, 0);
    // Whatever happened, the image's own code may have run (and may still be running, after a
    // timeout): neither region is freed from here.
    const uptr base = image.image.release();
    const u64 trampolines = image.trampolines.has_value() ? image.trampolines->release() : 0;
    if (!attached) {
        return std::unexpected(attached.error());
    }
    return mapped_module{.base = base, .trampolines = trampolines};
}

}
