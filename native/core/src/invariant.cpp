#include <lucent/core/invariant.hpp>

#include <atomic>
#include <source_location>

#include <intrin.h>

namespace lucent {
namespace {

// build: Windows SDK 10.0.26100.0, winnt.h
// found: FAST_FAIL_FATAL_APP_EXIT, documented for __fastfail
// breaks: the crash report names a different fail-fast reason; the process still terminates
constexpr u32 fast_fail_fatal_app_exit = 7;

[[noreturn]] auto fail_fast([[maybe_unused]] std::source_location where) -> void {
    __fastfail(fast_fail_fatal_app_exit);
}

// Owned by this file: written once by the host at startup, read on every violation.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables)
constinit std::atomic<invariant_handler> installed_handler{&fail_fast};

}

auto set_invariant_handler(invariant_handler handler) -> void {
    LUCENT_INVARIANT(handler != nullptr);
    installed_handler.store(handler, std::memory_order_release);
}

auto invariant_violated(std::source_location where) -> void {
    installed_handler.load(std::memory_order_acquire)(where);
    __fastfail(fast_fail_fatal_app_exit);
}

}
