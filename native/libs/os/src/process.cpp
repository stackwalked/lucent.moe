#include <lucent/os/process.hpp>

#include <expected>
#include <string>
#include <string_view>
#include <utility>

#include <Windows.h>

#include <TlHelp32.h>

#include <lucent/core/text.hpp>
#include <lucent/os/unique_handle.hpp>

#include "names.hpp"

namespace lucent::os {

auto process::open(u32 id) -> result<process> {
    constexpr DWORD rights = PROCESS_CREATE_THREAD
                             | PROCESS_QUERY_INFORMATION
                             | PROCESS_VM_OPERATION
                             | PROCESS_VM_WRITE
                             | PROCESS_VM_READ
                             | PROCESS_DUP_HANDLE
                             | SYNCHRONIZE;
    unique_handle handle{OpenProcess(rights, FALSE, id)};
    if (!handle.is_valid()) {
        return std::unexpected(last_system_error());
    }
    return process{id, std::move(handle)};
}

process::process(u32 id, unique_handle handle)
    : m_id(id)
    , m_handle(std::move(handle)) {}

auto process::id() const -> u32 {
    return m_id;
}

auto process::native() const -> void* {
    return m_handle.native();
}

auto find_process_id(std::string_view executable) -> result<u32> {
    const unique_handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)};
    if (!snapshot.is_valid()) {
        return std::unexpected(last_system_error());
    }
    const std::wstring wanted = to_wide(executable);
    PROCESSENTRY32W entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL more = Process32FirstW(snapshot.native(), &entry); more != FALSE;
        more = Process32NextW(snapshot.native(), &entry)) {
        if (detail::is_same_name(std::data(entry.szExeFile), wanted)) {
            return entry.th32ProcessID;
        }
    }
    return std::unexpected(error{.code = error_code::not_found});
}

}
