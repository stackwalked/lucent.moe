#include <bit>

#include <Windows.h>

#include <lucent/core/contain.hpp>
#include <lucent/core/fault.hpp>

// The image the container test packs and maps. Its boot entry registers the .pdata the container
// names, as kit's boot does, then reports, through an environment variable of the process it runs
// in, that a raise() inside it came back through contain(): which takes its imports bound by hash,
// its relocations applied (the message is read through a pointer the linker relocates), its
// .pdata where the container says, and the CRT's RtlPcToFileHeader redirected.

// The linker's symbol for this image's own base. The name is the linker's.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreserved-identifier" // the linker defines __ImageBase
// NOLINTNEXTLINE(bugprone-reserved-identifier,readability-identifier-naming): the linker's name.
extern "C" IMAGE_DOS_HEADER __ImageBase;
#pragma clang diagnostic pop

namespace {

// What the test hands the boot entry: the container's .pdata, from the image's base.
struct probe_boot {
    lucent::u32 pdata_rva;
    lucent::u32 pdata_size;
};

const wchar_t* const contained_message = L"contained";

// RUNTIME_FUNCTION: begin, end and unwind info, three u32s.
constexpr lucent::u32 runtime_function_size = 12;

auto report_containment() -> void {
    const lucent::contained<void> ran =
        lucent::contain([] { LUCENT_ENSURE(GetCurrentProcessId() == 0); });
    if (!ran && ran.error().kind == lucent::fault_kind::ensure_failed) {
        SetEnvironmentVariableW(L"LUCENT_CONTAINED_PROBE", contained_message);
    }
}

}

// The boot entry pack records as the container's boot RVA; started after the entry point, as a
// loader starts a module's. The table stays registered: the image stays mapped for the process's
// life.
extern "C" __declspec(dllexport) auto lucent_boot(const void* parameter) -> unsigned long;

extern "C" auto lucent_boot(const void* parameter) -> unsigned long {
    const auto* const given = static_cast<const probe_boot*>(parameter);
    const auto base = std::bit_cast<lucent::u64>(&__ImageBase);
    if (RtlAddFunctionTable(
            std::bit_cast<RUNTIME_FUNCTION*>(base + given->pdata_rva),
            given->pdata_size / runtime_function_size,
            base
        )
        == FALSE) {
        return 1;
    }
    report_containment();
    return 0;
}
