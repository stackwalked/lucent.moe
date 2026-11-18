#include <lucent/os/remote_call.hpp>

#include <bit>
#include <cstddef>
#include <expected>
#include <filesystem>
#include <span>
#include <string>
#include <tuple>

#include <Windows.h>

#include <lucent/os/process.hpp>
#include <lucent/os/remote_memory.hpp>
#include <lucent/os/unique_handle.hpp>

namespace lucent::os {
namespace {

// Long enough for a loader to run a large module's static initializers.
constexpr DWORD remote_call_timeout_ms = 10'000;

auto address_in_kernel32(const char* name) -> result<uptr> {
    const auto address =
        std::bit_cast<uptr>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name));
    if (address == 0) {
        return std::unexpected(last_system_error());
    }
    return address;
}

}

auto run_remote(const process& target, remote_call call) -> result<u32> {
    const auto routine = std::bit_cast<LPTHREAD_START_ROUTINE>(call.start);
    void* const argument = std::bit_cast<void*>(call.argument);
    const unique_handle thread{
        CreateRemoteThread(target.native(), nullptr, 0, routine, argument, 0, nullptr)
    };
    if (!thread.is_valid()) {
        return std::unexpected(last_system_error());
    }
    switch (WaitForSingleObject(thread.native(), remote_call_timeout_ms)) {
    case WAIT_OBJECT_0:
        break;
    case WAIT_TIMEOUT:
        return std::unexpected(error{.code = error_code::timed_out});
    default:
        return std::unexpected(last_system_error());
    }
    DWORD exit_code = 0;
    if (GetExitCodeThread(thread.native(), &exit_code) == 0) {
        return std::unexpected(last_system_error());
    }
    return exit_code;
}

auto load_library_remote(const process& target, const std::filesystem::path& library)
    -> result<void> {
    // kernel32 is mapped at the same base in every process of a boot (ASLR picks it once per boot),
    // so LoadLibraryW's address here is its address in the target too.
    const uptr load_library = LUCENT_TRY(address_in_kernel32("LoadLibraryW"));
    std::wstring terminated = library.native();
    terminated.push_back(L'\0');
    const std::span<const std::byte> path_bytes = std::as_bytes(std::span{terminated});
    remote_region path =
        LUCENT_TRY(remote_region::allocate(target, path_bytes.size(), page_access::read_write));
    LUCENT_TRY(path.write(0, path_bytes));
    const result<u32> loaded = run_remote(target, {.start = load_library, .argument = path.base()});
    if (!loaded) {
        // After a timeout LoadLibraryW may still be reading the path; leak it rather than free it
        // under the running thread.
        std::ignore = path.release();
        return std::unexpected(loaded.error());
    }
    // The exit code is the HMODULE cut to 32 bits: only zero, a failed load, means anything.
    if (*loaded == 0) {
        return std::unexpected(error{.code = error_code::not_found});
    }
    return {};
}

}
