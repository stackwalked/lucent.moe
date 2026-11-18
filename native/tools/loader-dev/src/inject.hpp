#pragma once

#include <filesystem>
#include <string_view>

#include <lucent/kit/boot_info.hpp>

namespace lucent::loader_dev {

// Loads the module into the process with the OS loader, on a remote thread.
auto load_library_remote(void* process, const std::filesystem::path& module) -> result<void>;

// The offset of an export from the module's base, read from a local, unresolved load of the file.
auto export_offset(const std::filesystem::path& module, std::string_view name) -> result<uptr>;

// Runs the module's entry point on a remote thread with this boot_info and waits for it.
auto start_remote(void* process, uptr entry, const kit::boot_info& info) -> result<void>;

}
