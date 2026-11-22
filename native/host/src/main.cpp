#include <charconv>
#include <memory>
#include <span>
#include <string>
#include <system_error>

#include <Windows.h>

#include <lucent/core/narrow.hpp>
#include <lucent/core/text.hpp>

// lucent-host: the process a host-placed product's module is mapped into, so it never shares one
// with the loader's tokens and device key (protection.md, Delivery). The loader spawns it with
// its own process id and maps the module into it as into a game; it lives until the loader goes.
// No product is host-placed yet (osu will be), so in Phase 1 it ships in the loader's seal and
// does nothing else.

namespace {

auto parent_of(std::span<const wchar_t* const> arguments) -> DWORD {
    if (arguments.size() != 2) {
        return 0;
    }
    const std::string text = lucent::to_utf8(arguments.back());
    DWORD id = 0;
    const std::from_chars_result parsed =
        std::from_chars(std::to_address(text.begin()), std::to_address(text.end()), id);
    if (parsed.ec != std::errc{} || parsed.ptr != std::to_address(text.end())) {
        return 0;
    }
    return id;
}

}

// The CRT's entry signature. argv is the CRT's array of argc pointers: the one place a span is
// built from a pointer and a count, and everything after reads it through that span.
// NOLINTNEXTLINE(misc-use-internal-linkage,cppcoreguidelines-avoid-c-arrays,modernize-avoid-c-arrays): the CRT calls wmain by this name and signature, as it does main.
auto wmain(int argc, wchar_t* argv[]) -> int {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // argc counts argv exactly
    const std::span<const wchar_t* const> arguments{argv, lucent::narrow<lucent::usize>(argc)};
#pragma clang diagnostic pop
    const DWORD parent = parent_of(arguments);
    if (parent == 0) {
        return 2;
    }
    void* const loader = OpenProcess(SYNCHRONIZE, FALSE, parent);
    if (loader == nullptr) {
        return 1;
    }
    WaitForSingleObject(loader, INFINITE);
    CloseHandle(loader);
    return 0;
}
