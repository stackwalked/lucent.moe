#pragma once

#include <span>

#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {

// Whether a user-mode debugger is attached to the process. `process` is a kernel handle with
// PROCESS_QUERY_INFORMATION; GetCurrentProcess() names our own.
auto debugger_presence(void* process) -> observation;

// Whether any of the threads has a hardware breakpoint armed or an address in a debug register.
// Each handle needs THREAD_GET_CONTEXT, and names a thread of one of our own processes.
auto hardware_breakpoints(std::span<void* const> threads) -> observation;

}
