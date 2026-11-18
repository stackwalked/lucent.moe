#include <lucent/kit/lifecycle.hpp>

#include <expected>
#include <memory>
#include <tuple>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/os/unique_handle.hpp>

#include "release.hpp"

namespace lucent::kit {
namespace {

auto is_unload(const session_message& message) -> bool {
    return match(
        message,
        [](const log_line&) { return false; },
        [](const stage_reached&) { return false; },
        [](const unload_request&) { return true; }
    );
}

auto report(session& channel, stage reached) -> void {
    // A failed report means the host is gone; the next receive() sees that and unloads.
    std::ignore = channel.send(stage_reached{.reached = reached});
}

auto wait_for_unload(session& channel) -> void {
    while (true) {
        const result<session_message> received = channel.receive();
        // A closed or broken channel means nobody is left to ask: unload.
        if (!received || is_unload(*received)) {
            return;
        }
    }
}

struct start_request {
    boot_info info;
    attach_fn attach = nullptr;
};

// Whether the module may be freed: not when detach couldn't show that no thread will run its code
// again.
auto run(const start_request& request) -> bool {
    session channel{session_ends{
        .inbound = os::unique_handle{request.info.from_host},
        .outbound = os::unique_handle{request.info.to_host},
    }};
    report(channel, stage::boot);
    bool is_detached = true;
    {
        // A target that fails to attach skips straight to detach: the host sees no attach stage.
        const result<std::unique_ptr<attachment>> attached = request.attach();
        if (attached) {
            report(channel, stage::attach);
            report(channel, stage::run);
            wait_for_unload(channel);
            is_detached = (*attached)->detach().has_value();
        }
        report(channel, stage::detach);
    }
    if (!is_detached) {
        return false;
    }
    report(channel, stage::unload);
    return true;
}

// A raw thread, the one exception to kit workers: it ends by freeing the module its own code lives
// in, so no object in the module may own it. A static std::jthread would be destroyed during that
// unload and join this very thread.
auto WINAPI lifecycle_main(void* parameter) -> DWORD {
    bool may_free = false;
    image_kind kind = image_kind::loaded;
    u64 trampolines = 0;
    {
        const std::unique_ptr<const start_request> request{
            static_cast<const start_request*>(parameter)
        };
        kind = request->info.kind;
        trampolines = request->info.trampolines;
        may_free = run(*request);
    }
    if (!may_free) {
        // Leaked on purpose: freeing would pull code out from under a thread still in it.
        return 0;
    }
    detail::release_module(kind, trampolines);
}

}

auto start(const boot_info& info, attach_fn attach) -> result<void> {
    LUCENT_INVARIANT(attach != nullptr);
    // The host wrote it: an unknown kind is bad input, and releasing by guess would crash later.
    if (info.kind != image_kind::loaded && info.kind != image_kind::mapped) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    auto owned = std::make_unique<start_request>(start_request{.info = info, .attach = attach});
    const os::unique_handle thread{
        CreateThread(nullptr, 0, &lifecycle_main, owned.get(), 0, nullptr)
    };
    if (!thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    // The thread owns it now.
    std::ignore = owned.release();
    return {};
}

}
