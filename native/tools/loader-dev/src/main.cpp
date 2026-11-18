#include <cstdio>
#include <print>
#include <span>
#include <thread>
#include <tuple>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/os/process.hpp>

#include "cli/describe.hpp"
#include "cli/options.hpp"
#include "inject/boot.hpp"
#include "inject/os_loader.hpp"
#include "session/channel.hpp"
#include "session/relay.hpp"

namespace lucent::loader_dev {
namespace {

auto run(const options& chosen) -> result<void> {
    const u32 process_id = LUCENT_TRY(os::find_process_id(chosen.process));
    const os::process target = LUCENT_TRY(os::process::open(process_id));
    const staged_module staged = LUCENT_TRY(stage_module(chosen.module));
    // Read before loading, so a module without the export never reaches the target.
    const u32 boot_offset = LUCENT_TRY(boot_entry_offset(staged.file));
    const uptr base = LUCENT_TRY(load_staged_module(target, staged));
    host_channel channel = LUCENT_TRY(open_channel(target));
    LUCENT_TRY(start_module(target, base + boot_offset, channel.boot));
    std::println("started in {} ({}); press Enter to unload", chosen.process, target.id());

    const std::jthread relaying{[&channel] { relay(channel.session); }};
    std::ignore = std::getchar();
    // Fails only if the module is already gone, which the relay reports.
    std::ignore = channel.session.send(kit::unload_request{});
    return {};
}

}
}

// The CRT's entry signature. argv is the CRT's array of argc pointers: the one place a span is
// built from a pointer and a count, and everything after reads it through that span.
// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT calls wmain by this name and signature, as it does main.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> arguments{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    const lucent::result<lucent::loader_dev::options> chosen =
        lucent::loader_dev::parse_options(arguments);
    if (!chosen) {
        return 2;
    }
    const lucent::result<void> ran = lucent::loader_dev::run(*chosen);
    if (!ran) {
        std::println(stderr, "loader-dev: {}", lucent::loader_dev::describe(ran.error()));
        return 1;
    }
    return 0;
}
