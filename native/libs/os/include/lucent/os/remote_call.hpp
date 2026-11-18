#pragma once

#include <filesystem>

#include <lucent/os/process.hpp>

namespace lucent::os {

// A function in another process, and the one pointer-sized argument a thread start routine gets.
struct remote_call {
    uptr start = 0;
    uptr argument = 0;
};

// Runs the call on a new thread in the process, waits for it, and returns its exit code.
auto run_remote(const process& target, remote_call call) -> result<u32>;

// Loads a library into the process with its own loader, as LoadLibraryW would there.
auto load_library_remote(const process& target, const std::filesystem::path& library)
    -> result<void>;

}
