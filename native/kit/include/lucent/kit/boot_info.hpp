#pragma once

#include <cstddef>
#include <type_traits>

namespace lucent::kit {

// How the module's image got into the process, which decides how it leaves.
enum class image_kind : u8 {
    // The OS loader: it frees the module (FreeLibraryAndExitThread).
    loaded,
    // Our mapper: the module tears its CRT down and frees its own image.
    mapped,
};

// What the host hands the module when it starts it. Written by one binary and read by another,
// so the layout is pinned below and any change bumps boot_info_version. The session protocol
// shares that version.
struct boot_info {
    u32 version = 0;
    image_kind kind = image_kind::loaded;
    // The module's ends of the session channel, already duplicated into its process.
    void* from_host = nullptr;
    void* to_host = nullptr;
    // Mapped only: the mapper's RtlPcToFileHeader trampoline region, freed with the image; 0 if
    // the mapper made none.
    u64 trampolines = 0;
    // The fact bundle, which the host wrote into the module's process. Borrowed only until the
    // boot entry returns: kit::start copies it. Null, with a size of 0, when the host has none.
    const std::byte* bundle = nullptr;
    u64 bundle_size = 0;
    // Mapped only, from the image's base: its entry point (the CRT's DllMain), which the module
    // calls again to tear its CRT down, and its .pdata, which it registers at boot and removes as
    // it unloads. A container keeps no headers to find them in. The .pdata is both 0 for none.
    u32 entry_rva = 0;
    u32 pdata_rva = 0;
    u32 pdata_size = 0;
};

// 4: the image's entry and .pdata, and the session's start_refused message. 5: the session's
// server_request and server_reply messages, which relay the lease client's calls.
inline constexpr u32 boot_info_version = 5;

static_assert(
    std::is_trivially_copyable_v<boot_info>, "the host copies boot_info across processes"
);
static_assert(
    sizeof(boot_info) == 64, "boot_info crosses binaries: a layout change bumps the version"
);
static_assert(offsetof(boot_info, kind) == 4, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, from_host) == 8, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, to_host) == 16, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, trampolines) == 24, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, bundle) == 32, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, bundle_size) == 40, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, entry_rva) == 48, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, pdata_rva) == 52, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, pdata_size) == 56, "boot_info's layout is pinned");

}
