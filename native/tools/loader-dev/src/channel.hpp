#pragma once

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/os/process.hpp>

namespace lucent::loader_dev {

struct host_channel {
    kit::session session;
    // Carries the module's ends, already transferred to the target process.
    kit::boot_info boot;
};

// Creates both pipes of a session and hands the module's ends to the process.
auto open_channel(const os::process& target) -> result<host_channel>;

}
