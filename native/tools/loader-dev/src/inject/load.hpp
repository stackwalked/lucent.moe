#pragma once

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/process.hpp>

#include "cli/options.hpp"

namespace lucent::loader_dev {

// A module in the target, not started yet.
// A module in the target, not started yet, and what its boot_info says about its image.
struct loaded_module {
    uptr base = 0;
    u32 boot_offset = 0;
    kit::image_kind kind = kit::image_kind::mapped;
    // Mapped only, as boot_info carries them.
    u64 trampolines = 0;
    u32 entry_rva = 0;
    u32 pdata_rva = 0;
    u32 pdata_size = 0;
};

// Reads the module, finds its boot entry, and only then puts it into the target the chosen way,
// so a module without one never reaches the target.
auto load_module(const os::process& target, const options& chosen) -> result<loaded_module>;

}
