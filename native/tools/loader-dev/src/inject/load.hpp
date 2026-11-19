#pragma once

#include <optional>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/process.hpp>

#include "cli/options.hpp"

namespace lucent::loader_dev {

// A module in the target, not started yet.
struct loaded_module {
    uptr base = 0;
    // Absent for a container mapped without --boot-from: there is no boot entry to run.
    std::optional<u32> boot_offset;
    kit::image_kind kind = kit::image_kind::mapped;
    u64 trampolines = 0;
};

// Reads the module, finds its boot export, and only then puts it into the target the chosen way,
// so a module without the export never reaches the target.
auto load_module(const os::process& target, const options& chosen) -> result<loaded_module>;

}
