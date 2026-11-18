#include <lucent/os/pipe.hpp>

#include <expected>

#include <Windows.h>

#include <lucent/os/process.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::os {

auto create_pipe() -> result<pipe> {
    HANDLE read_end = nullptr;
    HANDLE write_end = nullptr;
    if (CreatePipe(&read_end, &write_end, nullptr, 0) == 0) {
        return std::unexpected(last_system_error());
    }
    return pipe{
        .read_end = unique_handle{read_end},
        .write_end = unique_handle{write_end},
    };
}

auto transfer_to(const process& target, unique_handle handle) -> result<void*> {
    HANDLE transferred = nullptr;
    // DUPLICATE_CLOSE_SOURCE closes our copy whether or not duplication succeeds.
    const BOOL done = DuplicateHandle(
        GetCurrentProcess(),
        handle.release(),
        target.native(),
        &transferred,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE
    );
    if (done == 0) {
        return std::unexpected(last_system_error());
    }
    return transferred;
}

}
