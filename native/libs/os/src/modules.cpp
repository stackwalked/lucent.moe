#include <lucent/os/modules.hpp>

#include <bit>
#include <expected>
#include <filesystem>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <Windows.h>

#include <TlHelp32.h>

#include <lucent/core/text.hpp>
#include <lucent/os/process.hpp>
#include <lucent/os/unique_handle.hpp>

#include "names.hpp"

namespace lucent::os {
namespace {

constexpr error not_found{.code = error_code::not_found};

}

auto remote_modules(const process& target) -> result<std::vector<remote_module>> {
    // A snapshot can fail with ERROR_BAD_LENGTH while the process is loading or unloading a module;
    // callers retry if that matters to them.
    const unique_handle snapshot{
        CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, target.id())
    };
    if (!snapshot.is_valid()) {
        return std::unexpected(last_system_error());
    }
    std::vector<remote_module> modules;
    MODULEENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL more = Module32FirstW(snapshot.native(), &entry); more != FALSE;
        more = Module32NextW(snapshot.native(), &entry)) {
        modules.push_back(
            remote_module{
                .name = to_utf8(std::data(entry.szModule)),
                .path = std::filesystem::path{std::data(entry.szExePath)},
                .base = std::bit_cast<uptr>(entry.modBaseAddr),
                .size = entry.modBaseSize,
            }
        );
    }
    return modules;
}

auto find_remote_module(const process& target, std::string_view name) -> result<remote_module> {
    const std::wstring wanted = to_wide(name);
    for (remote_module& module : LUCENT_TRY(remote_modules(target))) {
        if (detail::is_same_name(to_wide(module.name), wanted)) {
            return std::move(module);
        }
    }
    return std::unexpected(not_found);
}

auto find_remote_module(const process& target, const std::filesystem::path& path)
    -> result<remote_module> {
    for (remote_module& module : LUCENT_TRY(remote_modules(target))) {
        if (detail::is_same_name(module.path.native(), path.native())) {
            return std::move(module);
        }
    }
    return std::unexpected(not_found);
}

}
