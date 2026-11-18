#include "inject.hpp"

#include <bit>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include <Windows.h>

#include <lucent/kit/boot_info.hpp>
#include <lucent/kit/unique_handle.hpp>

namespace lucent::loader_dev {
namespace {

// Long enough for LoadLibraryW to run the module's static initializers.
constexpr DWORD remote_thread_timeout_ms = 10'000;

// Memory allocated in another process, freed with it.
class remote_allocation final {
public:
    static auto from_bytes(void* process, std::span<const std::byte> bytes)
        -> result<remote_allocation> {
        void* address = VirtualAllocEx(
            process, nullptr, bytes.size(), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE
        );
        if (address == nullptr) {
            return std::unexpected(last_system_error());
        }
        remote_allocation allocation{process, std::bit_cast<uptr>(address)};
        if (WriteProcessMemory(process, address, bytes.data(), bytes.size(), nullptr) == 0) {
            return std::unexpected(last_system_error());
        }
        return allocation;
    }

    remote_allocation(const remote_allocation&) = delete ("remote memory has one owner");
    auto operator=(const remote_allocation&)
        -> remote_allocation& = delete ("remote memory has one owner");

    remote_allocation(remote_allocation&& other) noexcept
        : m_process(other.m_process)
        , m_address(std::exchange(other.m_address, nullptr)) {}

    auto operator=(remote_allocation&&) -> remote_allocation& = delete ("not needed");

    ~remote_allocation() {
        if (m_address != nullptr) {
            VirtualFreeEx(m_process, m_address, 0, MEM_RELEASE);
        }
    }

    auto address() const -> void* {
        return m_address;
    }

private:
    remote_allocation(void* process, uptr address)
        : m_process(process)
        , m_address(std::bit_cast<void*>(address)) {}

    void* m_process;
    void* m_address;
};

// Runs start(parameter) in the process and returns the thread's exit code.
auto run_remote(void* process, uptr start, void* parameter) -> result<u32> {
    const auto routine = std::bit_cast<LPTHREAD_START_ROUTINE>(start);
    const kit::unique_handle thread{
        CreateRemoteThread(process, nullptr, 0, routine, parameter, 0, nullptr)
    };
    if (!thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    if (WaitForSingleObject(thread.native(), remote_thread_timeout_ms) != WAIT_OBJECT_0) {
        return std::unexpected(last_system_error());
    }
    DWORD exit_code = 0;
    if (GetExitCodeThread(thread.native(), &exit_code) == 0) {
        return std::unexpected(last_system_error());
    }
    return exit_code;
}

auto address_in_kernel32(const char* name) -> result<uptr> {
    const auto procedure =
        std::bit_cast<uptr>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name));
    if (procedure == 0) {
        return std::unexpected(last_system_error());
    }
    return procedure;
}

}

auto load_library_remote(void* process, const std::filesystem::path& module) -> result<void> {
    // kernel32 is mapped at the same base in every process of a boot (ASLR picks it once per boot),
    // so LoadLibraryW's address here is its address in the target too.
    const uptr load_library = LUCENT_TRY(address_in_kernel32("LoadLibraryW"));
    std::wstring terminated = module.native();
    terminated.push_back(L'\0');
    const remote_allocation remote_path =
        LUCENT_TRY(remote_allocation::from_bytes(process, std::as_bytes(std::span{terminated})));
    // The exit code is the HMODULE truncated to 32 bits: only zero, a failed load, means anything.
    const u32 truncated_module =
        LUCENT_TRY(run_remote(process, load_library, remote_path.address()));
    if (truncated_module == 0) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    return {};
}

auto export_offset(const std::filesystem::path& module, std::string_view name) -> result<uptr> {
    // Mapped but not initialized: nothing in the module runs in this process.
    const HMODULE local = LoadLibraryExW(module.c_str(), nullptr, DONT_RESOLVE_DLL_REFERENCES);
    if (local == nullptr) {
        return std::unexpected(last_system_error());
    }
    const std::string terminated{name};
    const auto procedure = std::bit_cast<uptr>(GetProcAddress(local, terminated.c_str()));
    const error failure = last_system_error();
    FreeLibrary(local);
    if (procedure == 0) {
        return std::unexpected(failure);
    }
    return procedure - std::bit_cast<uptr>(local);
}

auto start_remote(void* process, uptr entry, const kit::boot_info& info) -> result<void> {
    const remote_allocation remote_info =
        LUCENT_TRY(remote_allocation::from_bytes(process, std::as_bytes(std::span{&info, 1})));
    const u32 exit_code = LUCENT_TRY(run_remote(process, entry, remote_info.address()));
    if (exit_code != 0) {
        return std::unexpected(error{.code = static_cast<error_code>(exit_code - 1)});
    }
    return {};
}

}
