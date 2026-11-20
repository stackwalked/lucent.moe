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
    // From the image's base. The entry point is 0 for none; .pdata, the exception directory, is
    // both 0 for none. The host hands them to the module's boot (kit::boot_info), which registers
    // .pdata and finds its entry again to unload, since a container keeps no headers to read.
    u32 entry_rva = 0;
    u32 pdata_rva = 0;
    u32 pdata_size = 0;
};

// Maps a DLL file into the process without its loader: sections at a fresh base, relocations
// applied, imports resolved (loading libraries the process lacks), section protections set. None
// of the image's code runs. Fails with error_code::unsupported for an image with a TLS directory.
auto map(const os::process& target, std::span<const std::byte> image_file) -> result<mapped>;

// Maps a container (wire/container.hpp) the same way: sections at a fresh base with their access
// and no access between them, relocation slots given the base, hashed imports resolved against
// the target's modules or System32's (loading those it lacks). The relocation list and the
// imports never reach the target. None of the image's code runs.
auto map_container(const os::process& target, const wire::container& image) -> result<mapped>;

// Runs the image's entry point for DLL_PROCESS_ATTACH, as the loader would: the CRT's initializer,
// then DllMain. `reserved` becomes DllMain's third argument and must be an address in the target,
// or 0. .pdata isn't registered yet: nothing may unwind through the image until its boot has
// registered it.
auto attach(const os::process& target, const mapped& image, uptr reserved) -> result<void>;

}
