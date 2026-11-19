#include <lucent/core/fault.hpp>

#include <bit>
#include <source_location>

#include <Windows.h>

#include <intrin.h>

#include <lucent/core/narrow.hpp>

// The linker's symbol for this image's own base. core is a static library, so the image is the one
// whose code called ensure_failed: a mapped module's own, wherever the mapper placed it.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreserved-identifier" // the linker defines __ImageBase
// NOLINTNEXTLINE(bugprone-reserved-identifier,readability-identifier-naming): the linker's name.
extern "C" IMAGE_DOS_HEADER __ImageBase;
#pragma clang diagnostic pop

namespace lucent {

// Never inlined, so its return address lies in the function holding the failed check. One byte
// back from it is inside the call instruction itself, which a symbolizer maps to the check's line
// even when the call is the last instruction of its function.
[[gnu::noinline]] auto ensure_failed(std::source_location where) -> void {
    const auto returned_to = std::bit_cast<uptr>(_ReturnAddress());
    const auto base = std::bit_cast<uptr>(&__ImageBase);
    raise({
        .kind = fault_kind::ensure_failed,
        .check = narrow<u32>(returned_to - 1 - base),
        .where = where,
        .instruction = 0,
        .address = 0,
        .is_write = false,
    });
}

}
