#include <cstdio>
#include <expected>
#include <filesystem>
#include <format>
#include <print>
#include <random>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <tuple>

#include <lucent/core/match.hpp>
#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>
#include <lucent/kit/session.hpp>
#include <lucent/kit/session_message.hpp>
#include <lucent/kit/unique_handle.hpp>

#include "channel.hpp"
#include "inject.hpp"
#include "process.hpp"

namespace lucent::loader_dev {
namespace {

struct options {
    std::filesystem::path module;
    std::wstring process = L"cs2.exe";
};

auto name_of(error_code code) -> std::string_view {
    switch (code) {
    case error_code::system:
        return "system";
    case error_code::closed:
        return "closed";
    case error_code::malformed:
        return "malformed";
    case error_code::not_found:
        return "not found";
    case error_code::version_mismatch:
        return "version mismatch";
    }
    return "unknown";
}

auto name_of(kit::stage reached) -> std::string_view {
    switch (reached) {
    case kit::stage::boot:
        return "boot";
    case kit::stage::attach:
        return "attach";
    case kit::stage::run:
        return "run";
    case kit::stage::detach:
        return "detach";
    case kit::stage::unload:
        return "unload";
    }
    return "unknown";
}

auto describe(const error& failure) -> std::string {
    if (failure.code == error_code::system) {
        return std::format("system error {}", failure.system_code);
    }
    return std::string{name_of(failure.code)};
}

// The OS loader locks the file it loads, so the module runs from a copy and the build stays free
// to overwrite the original. Copies left by earlier runs are removed once nothing holds them.
auto stage_copy(const std::filesystem::path& module) -> result<std::filesystem::path> {
    const std::filesystem::path directory = std::filesystem::temp_directory_path() / "lucent-dev";
    std::error_code failure;
    std::filesystem::create_directories(directory, failure);
    for (const std::filesystem::directory_entry& stale :
        std::filesystem::directory_iterator{directory, failure}) {
        std::error_code ignored;
        std::filesystem::remove(stale.path(), ignored);
    }
    std::random_device entropy;
    // Not const: it is returned, and const would block the move.
    std::filesystem::path copy = directory / std::format("{:08x}{:08x}.dll", entropy(), entropy());
    if (!std::filesystem::copy_file(module, copy, failure)) {
        return std::unexpected(
            error{.code = error_code::system, .system_code = narrow<u32>(failure.value())}
        );
    }
    return copy;
}

auto print_message(const kit::session_message& message) -> void {
    match(
        message,
        [](const kit::log_line& line) { std::println("module: {}", line.text); },
        [](const kit::stage_reached& reached) {
            std::println("stage: {}", name_of(reached.reached));
        },
        [](const kit::unload_request&) { std::println("module asked the host to unload?"); }
    );
}

// Prints what the module sends until it closes its end.
auto relay(kit::session& channel) -> void {
    while (true) {
        const result<kit::session_message> received = channel.receive();
        if (!received) {
            std::println("channel closed: {}", describe(received.error()));
            return;
        }
        print_message(*received);
    }
}

auto run(const options& chosen) -> result<void> {
    const u32 process_id = LUCENT_TRY(find_process(chosen.process));
    const std::filesystem::path copy = LUCENT_TRY(stage_copy(chosen.module));
    const uptr boot_offset = LUCENT_TRY(export_offset(copy, "lucent_boot"));
    const kit::unique_handle process = LUCENT_TRY(open_process(process_id));
    LUCENT_TRY(load_library_remote(process.native(), copy));
    const uptr base = LUCENT_TRY(module_base(process_id, copy));
    host_channel channel = LUCENT_TRY(open_channel(process.native()));
    LUCENT_TRY(start_remote(process.native(), base + boot_offset, channel.boot));
    std::println("started in {} ({}); press Enter to unload", to_utf8(chosen.process), process_id);

    const std::jthread relaying{[&channel] { relay(channel.session); }};
    std::ignore = std::getchar();
    // Fails only if the module is already gone, which the relay reports.
    std::ignore = channel.session.send(kit::unload_request{});
    return {};
}

auto parse(std::span<const wchar_t* const> arguments) -> result<options> {
    if (arguments.size() < 2 || arguments.size() > 3) {
        std::println(stderr, "usage: loader-dev <module.dll> [process name, default cs2.exe]");
        return std::unexpected(error{.code = error_code::malformed});
    }
    const std::span<const wchar_t* const> given = arguments.subspan(1);
    options chosen{.module = std::filesystem::absolute(given.front())};
    if (given.size() == 2) {
        chosen.process = given.back();
    }
    return chosen;
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
    const lucent::result<lucent::loader_dev::options> chosen = lucent::loader_dev::parse(arguments);
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
