#pragma once

#include <cstddef>
#include <span>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

// The offset of the module's lucent_boot export from its base, read from the module's file.
auto boot_entry_offset(std::span<const std::byte> module_file) -> result<u32>;

// Runs the module's boot entry on a remote thread with this boot_info, and waits for it.
auto start_module(const os::process& target, uptr entry, const kit::boot_info& info)
    -> result<void>;

}
