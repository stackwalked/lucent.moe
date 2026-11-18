#include "channel.hpp"

#include <expected>
#include <utility>

#include <Windows.h>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/unique_handle.hpp>

namespace lucent::loader_dev {
namespace {

struct pipe {
    kit::unique_handle read_end;
    kit::unique_handle write_end;
};

auto create_pipe() -> result<pipe> {
    HANDLE read_end = nullptr;
    HANDLE write_end = nullptr;
    if (CreatePipe(&read_end, &write_end, nullptr, 0) == 0) {
        return std::unexpected(last_system_error());
    }
    return pipe{
        .read_end = kit::unique_handle{read_end},
        .write_end = kit::unique_handle{write_end},
    };
}

// Moves our handle into the process: on return it is the target's, valid only there.
auto hand_over(kit::unique_handle handle, void* process) -> result<void*> {
    HANDLE duplicated = nullptr;
    // DUPLICATE_CLOSE_SOURCE closes our copy whether or not duplication succeeds.
    const BOOL handed = DuplicateHandle(
        GetCurrentProcess(),
        handle.release(),
        process,
        &duplicated,
        0,
        FALSE,
        DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE
    );
    if (handed == 0) {
        return std::unexpected(last_system_error());
    }
    return duplicated;
}

}

auto open_channel(void* process) -> result<host_channel> {
    pipe to_module = LUCENT_TRY(create_pipe());
    pipe to_host = LUCENT_TRY(create_pipe());
    void* module_inbound = LUCENT_TRY(hand_over(std::move(to_module.read_end), process));
    void* module_outbound = LUCENT_TRY(hand_over(std::move(to_host.write_end), process));
    return host_channel{
        .session = kit::session{kit::session_ends{
            .inbound = std::move(to_host.read_end),
            .outbound = std::move(to_module.write_end),
        }},
        .boot = kit::boot_info{
            .version = kit::boot_info_version,
            .from_host = module_inbound,
            .to_host = module_outbound,
        },
    };
}

}
