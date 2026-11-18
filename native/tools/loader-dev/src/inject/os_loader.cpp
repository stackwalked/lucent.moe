#include "inject/os_loader.hpp"

#include <cstddef>
#include <expected>
#include <filesystem>
#include <format>
#include <random>
#include <system_error>
#include <utility>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/modules.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/remote_call.hpp>

namespace lucent::loader_dev {
namespace {

auto copy_to_fresh_name(const std::filesystem::path& module) -> result<std::filesystem::path> {
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

}

auto stage_module(const std::filesystem::path& module) -> result<staged_module> {
    std::filesystem::path copy = LUCENT_TRY(copy_to_fresh_name(module));
    std::vector<std::byte> file = LUCENT_TRY(os::read_file(copy));
    return staged_module{.copy = std::move(copy), .file = std::move(file)};
}

auto load_staged_module(const os::process& target, const staged_module& staged) -> result<uptr> {
    LUCENT_TRY(os::load_library_remote(target, staged.copy));
    const os::remote_module loaded = LUCENT_TRY(os::find_remote_module(target, staged.copy));
    return loaded.base;
}

}
