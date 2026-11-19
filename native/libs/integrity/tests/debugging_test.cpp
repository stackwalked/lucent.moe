#include <lucent/integrity/debugging.hpp>

#include <array>
#include <bit>
#include <string>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/narrow.hpp>
#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {
namespace {

auto WINAPI idle(void* /*unused*/) noexcept -> DWORD {
    return 0;
}

// Never runs: the breakpoints the tests arm name it.
auto never_called() -> void {}

auto own_executable() -> std::wstring {
    std::wstring path(MAX_PATH, L'\0');
    const DWORD size = GetModuleFileNameW(nullptr, path.data(), narrow<DWORD>(path.size()));
    REQUIRE(size > 0);
    REQUIRE(size < path.size());
    path.resize(size);
    return path;
}

auto set_breakpoint(void* thread, void (*target)()) -> void {
    CONTEXT context{};
    context.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    REQUIRE(GetThreadContext(thread, &context) != 0);
    context.Dr0 = std::bit_cast<DWORD64>(target);
    // L0 enables Dr0 as an execution breakpoint; a null target clears it.
    context.Dr7 = target != nullptr ? 1 : 0;
    REQUIRE(SetThreadContext(thread, &context) != 0);
}

auto suspended_thread() -> void* {
    void* const thread = CreateThread(nullptr, 0, &idle, nullptr, CREATE_SUSPENDED, nullptr);
    REQUIRE(thread != nullptr);
    return thread;
}

auto finish(void* thread) -> void {
    ResumeThread(thread);
    WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
}

TEST_CASE("the debug port agrees with the PEB's flag for this process") {
    const observation expected =
        IsDebuggerPresent() != 0 ? observation::raised : observation::clear;

    CHECK(debugger_presence(GetCurrentProcess()) == expected);
}

TEST_CASE("a process we debug reports a debugger") {
    std::wstring command_line = own_executable();
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION child{};
    REQUIRE(
        CreateProcessW(
            nullptr,
            command_line.data(),
            nullptr,
            nullptr,
            FALSE,
            DEBUG_ONLY_THIS_PROCESS | CREATE_SUSPENDED,
            nullptr,
            nullptr,
            &startup,
            &child
        )
        != 0
    );

    CHECK(debugger_presence(child.hProcess) == observation::raised);
    TerminateProcess(child.hProcess, 0);
    DebugActiveProcessStop(child.dwProcessId);
    CloseHandle(child.hThread);
    CloseHandle(child.hProcess);
}

TEST_CASE("a hardware breakpoint on one of our threads is raised, and gone once cleared") {
    void* const thread = suspended_thread();
    const std::array threads{thread};
    CHECK(hardware_breakpoints(threads) == observation::clear);

    set_breakpoint(thread, &never_called);
    CHECK(hardware_breakpoints(threads) == observation::raised);

    set_breakpoint(thread, nullptr);
    CHECK(hardware_breakpoints(threads) == observation::clear);
    finish(thread);
}

TEST_CASE("a thread we may not read is unavailable, unless another one is raised") {
    void* const armed = suspended_thread();
    void* const unreadable =
        OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, GetThreadId(armed));
    REQUIRE(unreadable != nullptr);

    const std::array only_unreadable{unreadable};
    CHECK(hardware_breakpoints(only_unreadable) == observation::unavailable);

    set_breakpoint(armed, &never_called);
    const std::array both{unreadable, armed};
    CHECK(hardware_breakpoints(both) == observation::raised);

    set_breakpoint(armed, nullptr);
    CloseHandle(unreadable);
    finish(armed);
}

}
}
