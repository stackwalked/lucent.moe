#include <lucent/kit/lifecycle.hpp>

#include <expected>
#include <memory>
#include <tuple>

#include <Windows.h>

#include <lucent/core/match.hpp>
#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/kit/unique_handle.hpp>

// The linker's symbol for this image's own base, which is its HMODULE. The name is the linker's.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreserved-identifier" // the linker defines __ImageBase
// NOLINTNEXTLINE(bugprone-reserved-identifier,readability-identifier-naming): the linker's name.
extern "C" IMAGE_DOS_HEADER __ImageBase;
#pragma clang diagnostic pop

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

auto run(const boot_info& info) -> void {
    session channel{session_ends{
        .inbound = unique_handle{info.from_host},
        .outbound = unique_handle{info.to_host},
    }};
    report(channel, stage::boot);
    report(channel, stage::attach);
    report(channel, stage::run);
    wait_for_unload(channel);
    report(channel, stage::detach);
    report(channel, stage::unload);
}

// A raw thread, the one exception to kit workers: it ends by freeing the module its own code lives
// in, so no object in the module may own it. A static std::jthread would be destroyed during that
// unload and join this very thread.
auto WINAPI lifecycle_main(void* parameter) -> DWORD {
    {
        const std::unique_ptr<const boot_info> info{static_cast<const boot_info*>(parameter)};
        run(*info);
    }
    // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): __ImageBase is this module's HMODULE by definition.
    FreeLibraryAndExitThread(reinterpret_cast<HMODULE>(&__ImageBase), 0);
}

}

auto start(const boot_info& info) -> result<void> {
    auto owned = std::make_unique<boot_info>(info);
    const unique_handle thread{CreateThread(nullptr, 0, &lifecycle_main, owned.get(), 0, nullptr)};
    if (!thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    // The thread owns it now.
    std::ignore = owned.release();
    return {};
}

}
