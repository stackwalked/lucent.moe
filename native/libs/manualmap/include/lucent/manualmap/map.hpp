#pragma once

#include <cstddef>
#include <optional>
#include <span>

#include <lucent/os/process.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/wire/container.hpp>

namespace lucent::manualmap {

// An image mapped into another process. Holds every allocation the image needs for its lifetime, so
// dropping this frees them together. image owns the image's pages; trampolines owns the
// RtlPcToFileHeader redirect code when the image imports that function.
struct mapped {
    os::remote_region image;
    std::optional<os::remote_region> trampolines;
    // All absolute, in the target.
    uptr entry_point = 0;
    uptr exception_table = 0; // base of .pdata; 0 when the image has no exception directory
    u32 exception_count = 0; // RUNTIME_FUNCTION entries
};

// Maps a DLL file into the process without its loader: sections at a fresh base, relocations
// applied, imports resolved (loading libraries the process lacks), section protections set. None
// of the image's code runs. Fails with error_code::unsupported for an image with a TLS directory.
auto map(const os::process& target, std::span<const std::byte> image_file) -> result<mapped>;

// Maps a container (wire/container.hpp) the same way: sections at a fresh base with their access
// and no access between them, relocation slots given the base, hashed imports resolved against
// the target's modules or System32's (loading those it lacks). The relocation list and the
// imports never reach the target. None of the image's code runs. The container's .pdata is in
// the result for attach to register.
auto map_container(const os::process& target, const wire::container& image) -> result<mapped>;

// Runs the image's entry point for DLL_PROCESS_ATTACH, as the loader would: registers .pdata so x64
// unwinding works, then calls the CRT's initializer and DllMain. `reserved` becomes DllMain's third
// argument and must be an address in the target, or 0.
auto attach(const os::process& target, const mapped& image, uptr reserved) -> result<void>;

}
