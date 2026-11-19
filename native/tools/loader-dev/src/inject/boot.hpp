#pragma once

#include <cstddef>
#include <span>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

// The offset of the module's lucent_boot export from its base, read from the module's file.
auto boot_entry_offset(std::span<const std::byte> module_file) -> result<u32>;

struct boot_request {
    // The boot entry's address in the target.
    uptr entry = 0;
    kit::boot_info info;
    // Written into the target for the boot entry to copy; empty for none.
    std::span<const std::byte> bundle;
};

// Runs the module's boot entry on a remote thread with this boot_info, and waits for it. The
// bundle is written into the target and pointed at from boot_info; both are freed once the entry
// returns, by which time the module has copied what it keeps.
auto start_module(const os::process& target, const boot_request& request) -> result<void>;

}
