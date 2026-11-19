#pragma once

#include <expected>
#include <source_location>

namespace lucent {

enum class fault_kind : u8 {
    // LUCENT_ENSURE failed: the world surprised us.
    ensure_failed,
    // Faults in memory we touched, turned into faults by contain().
    access_violation,
    page_error,
    misaligned,
};

// Why a contained call stopped. Codes and addresses, like error.
struct fault {
    fault_kind kind = fault_kind::ensure_failed;
    // ensure_failed: the failing check's RVA in the image that holds it, which the PDB archived
    // with that build symbolizes. A memory fault leaves it 0: its instruction says where, and the
    // code that called contain() knows what it ran.
    u32 check = 0;
    // ensure_failed in a dev build: the check, readable. Empty in every other build, which ships no
    // file or function names.
    std::source_location where;
    // A memory fault: the faulting instruction and, for an access violation or page error, the
    // address it touched.
    uptr instruction = 0;
    uptr address = 0;
    bool is_write = false;
};

template <typename T>
using contained = std::expected<T, fault>;

// Throws the fault for the innermost contain() to return. The one throw in the codebase.
[[noreturn]] auto raise(const fault& thrown) -> void;

// LUCENT_ENSURE's failure: raises an ensure_failed fault located at its caller, the failing check.
[[noreturn]] auto ensure_failed(std::source_location where) -> void;

}

// The world surprised us: the running feature stops, through the contain() around it, and is
// disabled. Our own mistakes are LUCENT_INVARIANT. Its location is recorded as LUCENT_INVARIANT's
// is.
#if LUCENT_READABLE_CHECKS
#define LUCENT_ENSURE(condition)                                                                   \
    ((condition) ? static_cast<void>(0)                                                            \
                 : ::lucent::ensure_failed(::std::source_location::current()))
#else
#define LUCENT_ENSURE(condition)                                                                   \
    ((condition) ? static_cast<void>(0) : ::lucent::ensure_failed(::std::source_location{}))
#endif
