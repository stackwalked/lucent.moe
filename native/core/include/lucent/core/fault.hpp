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
    // ensure_failed: the check. A memory fault leaves it empty: its instruction says where, and
    // the code that called contain() knows what it ran.
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

}

// The world surprised us: the running feature stops, through the contain() around it, and is
// disabled. Our own mistakes are LUCENT_INVARIANT.
#define LUCENT_ENSURE(condition)                                                                   \
    ((condition) ? static_cast<void>(0)                                                            \
                 : ::lucent::raise({                                                               \
                       .kind = ::lucent::fault_kind::ensure_failed,                                \
                       .where = ::std::source_location::current(),                                 \
                       .instruction = 0,                                                           \
                       .address = 0,                                                               \
                       .is_write = false,                                                          \
                   }))
