#pragma once

#include <cstddef>
#include <type_traits>

namespace lucent::kit {

// What the host hands the module when it starts it. Written by one binary and read by another,
// so the layout is pinned below and any change bumps boot_info_version. The session protocol
// shares that version.
struct boot_info {
    u32 version = 0;
    // The module's ends of the session channel, already duplicated into its process.
    void* from_host = nullptr;
    void* to_host = nullptr;
};

inline constexpr u32 boot_info_version = 1;

static_assert(
    std::is_trivially_copyable_v<boot_info>, "the host copies boot_info across processes"
);
static_assert(
    sizeof(boot_info) == 24, "boot_info crosses binaries: a layout change bumps the version"
);
static_assert(offsetof(boot_info, from_host) == 8, "boot_info's layout is pinned");
static_assert(offsetof(boot_info, to_host) == 16, "boot_info's layout is pinned");

}
