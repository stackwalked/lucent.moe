#pragma once

#include <cstddef>
#include <span>

#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

struct mapped_module {
    uptr base = 0;
    // The mapper's RtlPcToFileHeader trampoline region; 0 if it made none.
    u64 trampolines = 0;
};

// Maps the module and runs its CRT startup. From then on the module owns both regions and frees
// them itself when it unloads.
auto map_module(const os::process& target, std::span<const std::byte> file)
    -> result<mapped_module>;

}
