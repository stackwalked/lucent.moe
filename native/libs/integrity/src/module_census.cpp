#include <lucent/integrity/module_census.hpp>

#include <algorithm>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include <Windows.h>

#include <Psapi.h>

#include <lucent/core/narrow.hpp>
#include <lucent/crypto/crypto.hpp>
#include <lucent/os/file.hpp>
#include <lucent/os/unique_handle.hpp>

#include "signer.hpp"

namespace lucent::integrity {
namespace {

// Bounds the walk over another process's module list, which it can grow while we read it.
constexpr usize module_limit = 4096;
constexpr DWORD path_capacity = 32'768;

auto loaded_modules(void* process) -> result<std::vector<HMODULE>> {
    std::vector<HMODULE> modules(256);
    while (true) {
        const auto capacity = narrow<DWORD>(modules.size() * sizeof(HMODULE));
        DWORD needed = 0;
        if (K32EnumProcessModulesEx(process, modules.data(), capacity, &needed, LIST_MODULES_ALL)
            == 0) {
            return std::unexpected(last_system_error());
        }
        const usize count = needed / sizeof(HMODULE);
        if (needed <= capacity || modules.size() >= module_limit) {
            modules.resize(std::min({count, modules.size(), module_limit}));
            return modules;
        }
        modules.resize(std::min(count, module_limit));
    }
}

auto file_path(void* process, HMODULE module) -> std::optional<std::wstring> {
    std::wstring path(path_capacity, L'\0');
    const DWORD length = K32GetModuleFileNameExW(process, module, path.data(), path_capacity);
    if (length == 0 || length >= path_capacity) {
        return std::nullopt;
    }
    path.resize(length);
    return path;
}

auto has_hash_slot(const module_census& census) -> bool {
    return census.unsigned_file_count < hashed_unsigned_limit;
}

auto record_unsigned(
    module_census& census, const std::wstring& path, std::span<const crypto::digest> known
) -> void {
    ++census.without_signature;
    if (!has_hash_slot(census)) {
        return;
    }
    const result<std::vector<std::byte>> contents = os::read_file(std::filesystem::path{path});
    if (!contents) {
        return;
    }
    const crypto::digest hash = crypto::hash(*contents);
    if (std::ranges::contains(known, hash)) {
        return;
    }
    census.unsigned_files.at(census.unsigned_file_count) = hash;
    ++census.unsigned_file_count;
}

auto record(
    module_census& census, void* process, HMODULE module, std::span<const crypto::digest> known
) -> void {
    const std::optional<std::wstring> path = file_path(process, module);
    if (!path) {
        ++census.unreadable;
        return;
    }
    const os::unique_handle file{CreateFileW(
        path->c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr
    )};
    if (!file.is_valid()) {
        ++census.unreadable;
        return;
    }
    switch (detail::signer_of(file.native(), *path)) {
    case detail::signer::microsoft:
        ++census.by_microsoft;
        return;
    case detail::signer::other:
        ++census.by_other_signer;
        return;
    case detail::signer::none:
        record_unsigned(census, *path, known);
        return;
    }
    LUCENT_UNREACHABLE();
}

}

auto module_census_of(void* process, std::span<const crypto::digest> known)
    -> result<module_census> {
    module_census census{};
    for (const HMODULE module : LUCENT_TRY(loaded_modules(process))) {
        record(census, process, module, known);
    }
    return census;
}

}
