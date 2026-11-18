#include "process.hpp"

#include <bit>
#include <expected>
#include <filesystem>
#include <string_view>

#include <Windows.h>

#include <TlHelp32.h>

#include <lucent/core/narrow.hpp>
#include <lucent/kit/unique_handle.hpp>

namespace lucent::loader_dev {
namespace {

constexpr error not_found{.code = error_code::not_found};

auto is_same_name(std::wstring_view left, std::wstring_view right) -> bool {
    const auto left_size = narrow<int>(std::ssize(left));
    const auto right_size = narrow<int>(std::ssize(right));
    return CompareStringOrdinal(left.data(), left_size, right.data(), right_size, TRUE)
           == CSTR_EQUAL;
}

auto snapshot(DWORD kinds, u32 process_id) -> result<kit::unique_handle> {
    kit::unique_handle taken{CreateToolhelp32Snapshot(kinds, process_id)};
    if (!taken.is_valid()) {
        return std::unexpected(last_system_error());
    }
    return taken;
}

}

auto find_process(std::wstring_view executable) -> result<u32> {
    const kit::unique_handle processes = LUCENT_TRY(snapshot(TH32CS_SNAPPROCESS, 0));
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL more = Process32FirstW(processes.native(), &entry); more != FALSE;
        more = Process32NextW(processes.native(), &entry)) {
        if (is_same_name(std::data(entry.szExeFile), executable)) {
            return entry.th32ProcessID;
        }
    }
    return std::unexpected(not_found);
}

auto open_process(u32 process_id) -> result<kit::unique_handle> {
    constexpr DWORD rights = PROCESS_CREATE_THREAD
                             | PROCESS_QUERY_INFORMATION
                             | PROCESS_VM_OPERATION
                             | PROCESS_VM_WRITE
                             | PROCESS_VM_READ
                             | PROCESS_DUP_HANDLE
                             | SYNCHRONIZE;
    kit::unique_handle process{OpenProcess(rights, FALSE, process_id)};
    if (!process.is_valid()) {
        return std::unexpected(last_system_error());
    }
    return process;
}

auto module_base(u32 process_id, const std::filesystem::path& module) -> result<uptr> {
    const kit::unique_handle modules = LUCENT_TRY(snapshot(TH32CS_SNAPMODULE, process_id));
    MODULEENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL more = Module32FirstW(modules.native(), &entry); more != FALSE;
        more = Module32NextW(modules.native(), &entry)) {
        if (is_same_name(std::data(entry.szExePath), module.native())) {
            return std::bit_cast<uptr>(entry.modBaseAddr);
        }
    }
    return std::unexpected(not_found);
}

}
