#include <Windows.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>

// The image the container test packs and maps. Attaching it reports, through an environment
// variable of the process it runs in, that a raise() inside it came back through contain(): which
// takes its imports bound by hash, its relocations applied (the message is read through a pointer
// the linker relocates), its .pdata registered, and the CRT's RtlPcToFileHeader redirected.

namespace {

const wchar_t* const contained_message = L"contained";

auto report_containment() -> void {
    const lucent::contained<void> ran =
        lucent::contain([] { LUCENT_ENSURE(GetCurrentProcessId() == 0); });
    if (!ran && ran.error().kind == lucent::fault_kind::ensure_failed) {
        SetEnvironmentVariableW(L"LUCENT_CONTAINED_PROBE", contained_message);
    }
}

}

// The CRT's _DllMainCRTStartup calls this by name, with the loader's arguments.
// NOLINTNEXTLINE(misc-use-internal-linkage,readability-identifier-naming): the CRT's name.
extern "C" auto WINAPI DllMain(
    [[maybe_unused]] HINSTANCE instance, DWORD reason, [[maybe_unused]] void* reserved
) -> BOOL {
    if (reason == DLL_PROCESS_ATTACH) {
        report_containment();
    }
    return TRUE;
}

// The boot entry pack records as the container's boot RVA; started after the entry point, as a
// loader starts a module's.
extern "C" __declspec(dllexport) auto lucent_boot(const void* parameter) -> unsigned long;

extern "C" auto lucent_boot([[maybe_unused]] const void* parameter) -> unsigned long {
    SetEnvironmentVariableW(L"LUCENT_CONTAINED_PROBE_BOOT", L"booted");
    return 0;
}
