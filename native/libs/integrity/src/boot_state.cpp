#include <lucent/integrity/boot_state.hpp>

#include <Windows.h>

#include <winternl.h>

#include <lucent/integrity/observation.hpp>

namespace lucent::integrity {
namespace {

// SYSTEM_KERNEL_DEBUGGER_INFORMATION, which the SDK doesn't declare: two BOOLEANs.
// build: 10.0.26100 (layout and class unchanged since NT 4).
// found: phnt ntexapi.h; Geoff Chappell's SYSTEM_INFORMATION_CLASS notes (class 0x23).
// breaks: a wrong class fails the query (unavailable); a wrong layout reads the second byte,
// which is set on a healthy machine, and every session reports kernel debugging.
struct kernel_debugger_information {
    BOOLEAN is_enabled;
    BOOLEAN is_not_present;
};

constexpr auto system_kernel_debugger_information = static_cast<SYSTEM_INFORMATION_CLASS>(0x23);

auto kernel_debugging() -> observation {
    kernel_debugger_information information{};
    const NTSTATUS status = NtQuerySystemInformation(
        system_kernel_debugger_information, &information, sizeof(information), nullptr
    );
    if (status < 0) {
        return observation::unavailable;
    }
    return information.is_enabled != 0 ? observation::raised : observation::clear;
}

}

auto system_boot_state() -> boot_state {
    SYSTEM_CODEINTEGRITY_INFORMATION integrity{};
    integrity.Length = sizeof(integrity);
    const NTSTATUS status = NtQuerySystemInformation(
        SystemCodeIntegrityInformation, &integrity, sizeof(integrity), nullptr
    );
    if (status < 0) {
        return boot_state{
            .kernel_debugging = kernel_debugging(),
            .test_signing = observation::unavailable,
            .enforcement_off = observation::unavailable,
        };
    }
    const ULONG options = integrity.CodeIntegrityOptions;
    return boot_state{
        .kernel_debugging = kernel_debugging(),
        .test_signing = (options & CODEINTEGRITY_OPTION_TESTSIGN) != 0 ? observation::raised
                                                                       : observation::clear,
        .enforcement_off = (options & CODEINTEGRITY_OPTION_ENABLED) != 0 ? observation::clear
                                                                         : observation::raised,
    };
}

}
