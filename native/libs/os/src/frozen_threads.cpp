#include <lucent/os/frozen_threads.hpp>

#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <Windows.h>

#include <TlHelp32.h>

#include <lucent/os/unique_handle.hpp>

namespace lucent::os {
namespace {

// SuspendThread's failure value.
constexpr DWORD suspend_failed = static_cast<DWORD>(-1);

// Allocates; called before anything is frozen.
auto other_thread_ids() -> result<std::vector<DWORD>> {
    const unique_handle snapshot{CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)};
    if (!snapshot.is_valid()) {
        return std::unexpected(last_system_error());
    }
    const DWORD process = GetCurrentProcessId();
    const DWORD self = GetCurrentThreadId();
    std::vector<DWORD> ids;
    THREADENTRY32 entry{};
    entry.dwSize = sizeof(entry);
    for (BOOL found = Thread32First(snapshot.native(), &entry); found != FALSE;
        found = Thread32Next(snapshot.native(), &entry)) {
        if (entry.th32OwnerProcessID == process && entry.th32ThreadID != self) {
            ids.push_back(entry.th32ThreadID);
        }
    }
    return ids;
}

}

auto frozen_threads::freeze_others() -> result<frozen_threads> {
    const std::vector<DWORD> ids = LUCENT_TRY(other_thread_ids());
    frozen_threads frozen;
    // Both reserved up front: nothing below may allocate once the first thread is suspended.
    frozen.m_threads.reserve(ids.size());
    frozen.m_instruction_pointers.reserve(ids.size());
    for (const DWORD id : ids) {
        unique_handle thread{OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT, FALSE, id)};
        // A thread that exited since the snapshot can't run anything of ours.
        if (!thread.is_valid() || SuspendThread(thread.native()) == suspend_failed) {
            continue;
        }
        frozen.m_threads.push_back(std::move(thread));
    }
    for (const unique_handle& thread : frozen.m_threads) {
        // Suspension is asynchronous; GetThreadContext returns only once the thread has stopped.
        CONTEXT context{};
        context.ContextFlags = CONTEXT_CONTROL;
        if (GetThreadContext(thread.native(), &context) == FALSE) {
            // Where it stopped is unknown, so nothing can be concluded: resume all (destructor).
            return std::unexpected(last_system_error());
        }
        frozen.m_instruction_pointers.push_back(context.Rip);
    }
    return frozen;
}

frozen_threads::~frozen_threads() {
    for (const unique_handle& thread : m_threads) {
        ResumeThread(thread.native());
    }
}

auto frozen_threads::instruction_pointers() const -> std::span<const uptr> {
    return m_instruction_pointers;
}

}
