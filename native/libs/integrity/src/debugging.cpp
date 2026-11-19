#include <lucent/integrity/debugging.hpp>

#include <span>

#include <Windows.h>

#include <winternl.h>

#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {
namespace {

// Dr7's local and global enable bits for Dr0 to Dr3; the bits above them only describe the
// breakpoints.
// found: Intel SDM vol. 3B, 18.2.4 "Debug Control Register (DR7)".
constexpr DWORD64 breakpoint_enables = 0xff;

auto breakpoints_of(void* thread) -> observation {
    CONTEXT context{};
    context.ContextFlags = CONTEXT_DEBUG_REGISTERS;
    if (GetThreadContext(thread, &context) == 0) {
        return observation::unavailable;
    }
    // An address loaded but not enabled still says someone was there.
    const bool is_armed = (context.Dr7 & breakpoint_enables) != 0
                          || context.Dr0 != 0
                          || context.Dr1 != 0
                          || context.Dr2 != 0
                          || context.Dr3 != 0;
    return is_armed ? observation::raised : observation::clear;
}

}

auto debugger_presence(void* process) -> observation {
    // The kernel sets a process's debug port while a debug object is attached to it, whatever the
    // PEB's BeingDebugged byte claims: a debugger can clear that byte, not the port.
    DWORD_PTR port = 0;
    const NTSTATUS status =
        NtQueryInformationProcess(process, ProcessDebugPort, &port, sizeof(port), nullptr);
    if (status < 0) {
        return observation::unavailable;
    }
    return port != 0 ? observation::raised : observation::clear;
}

auto hardware_breakpoints(std::span<void* const> threads) -> observation {
    observation combined = observation::clear;
    for (void* const thread : threads) {
        const observation found = breakpoints_of(thread);
        if (found == observation::raised) {
            return observation::raised;
        }
        if (found == observation::unavailable) {
            combined = observation::unavailable;
        }
    }
    return combined;
}

}
