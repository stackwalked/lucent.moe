#pragma once

#include <lucent/os/process.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::os {

// One direction of an anonymous pipe.
struct pipe {
    unique_handle read_end;
    unique_handle write_end;
};

auto create_pipe() -> result<pipe>;

// Hands a handle to another process: ours is closed, and the returned value is valid only there.
auto transfer_to(const process& target, unique_handle handle) -> result<void*>;

}
