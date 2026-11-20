#include "release.hpp"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>

#include <Windows.h>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/address_range.hpp>

#include "unmap_stub.hpp"

// The linker's symbol for this image's own base, which is its HMODULE. The name is the linker's.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wreserved-identifier" // the linker defines __ImageBase
// NOLINTNEXTLINE(bugprone-reserved-identifier,readability-identifier-naming): the linker's name.
extern "C" IMAGE_DOS_HEADER __ImageBase;
#pragma clang diagnostic pop

namespace lucent::kit::detail {
namespace {

using entry_point = BOOL(WINAPI*)(HINSTANCE, DWORD, void*);
using unmap_stub = void (*)(const unmap_args*);

auto own_base() -> uptr {
    return std::bit_cast<uptr>(&__ImageBase);
}

auto kernel32_function(const char* name) -> result<u64> {
    const auto address =
        std::bit_cast<u64>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name));
    if (address == 0) {
        return std::unexpected(last_system_error());
    }
    return address;
}

auto write_stub(const unmap_args& args) -> result<std::byte*> {
    void* const page =
        VirtualAlloc(nullptr, unmap_page_size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (page == nullptr) {
        return std::unexpected(last_system_error());
    }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // VirtualAlloc'd that size
    const std::span<std::byte> bytes{static_cast<std::byte*>(page), unmap_page_size};
#pragma clang diagnostic pop
    std::ranges::copy(std::as_bytes(std::span{unmap_stub_bytes}), bytes.begin());
    std::ranges::copy(std::as_bytes(std::span{&args, 1}), bytes.subspan(unmap_args_offset).begin());
    DWORD previous = 0;
    if (VirtualProtect(page, unmap_page_size, PAGE_EXECUTE_READ, &previous) == 0) {
        return std::unexpected(last_system_error());
    }
    return bytes.data();
}

// Worked out while the CRT still runs.
auto plan_unmap(const own_image& image) -> result<std::byte*> {
    const u64 virtual_free = LUCENT_TRY(kernel32_function("VirtualFree"));
    const u64 exit_thread = LUCENT_TRY(kernel32_function("ExitThread"));
    return write_stub(
        unmap_args{
            .image = own_base(),
            .trampolines = image.trampolines,
            .virtual_free = virtual_free,
            .exit_thread = exit_thread,
            .exit_code = 0,
        }
    );
}

[[noreturn]] auto unmap_self(const own_image& image) -> void {
    const result<std::byte*> stub_page = plan_unmap(image);
    if (!stub_page) {
        // Mapped and inert is safe; freeing an image we can't leave cleanly isn't.
        ExitThread(0);
    }
    // The CRT's teardown: static destructors, atexit, and its FLS index, whose callback lives in
    // this image and would otherwise run at every later thread exit. No CRT after this line.
    std::bit_cast<entry_point>(image.entry)(
        std::bit_cast<HINSTANCE>(own_base()), DLL_PROCESS_DETACH, nullptr
    );
    if (image.function_table != 0) {
        RtlDeleteFunctionTable(std::bit_cast<RUNTIME_FUNCTION*>(image.function_table));
    }
    const auto page = std::bit_cast<uptr>(*stub_page);
    const auto stub = std::bit_cast<unmap_stub>(page);
    stub(std::bit_cast<const unmap_args*>(page + unmap_args_offset));
    // The stub ends the thread; reaching here means its bytes are wrong.
    LUCENT_UNREACHABLE();
}

auto adopt_mapped(const boot_info& info) -> result<own_image> {
    const uptr base = own_base();
    const os::address_range allocation = LUCENT_TRY(os::allocation_containing(base));
    const image_layout layout{
        .entry_rva = info.entry_rva,
        .pdata_rva = info.pdata_rva,
        .pdata_size = info.pdata_size,
    };
    if (allocation.begin != base || !fits(layout, allocation.end - allocation.begin)) {
        return std::unexpected(error{.code = error_code::malformed});
    }
    own_image adopted{
        .kind = image_kind::mapped,
        .base = base,
        .size = allocation.end - allocation.begin,
        .trampolines = info.trampolines,
        .entry = base + layout.entry_rva,
        .function_table = 0,
    };
    if (layout.pdata_size == 0) {
        return adopted;
    }
    const uptr table = base + layout.pdata_rva;
    if (RtlAddFunctionTable(
            std::bit_cast<RUNTIME_FUNCTION*>(table), layout.pdata_size / runtime_function_size, base
        )
        == FALSE) {
        // RtlAddFunctionTable sets no Windows error; it refuses only a table it can't take.
        return std::unexpected(error{.code = error_code::malformed});
    }
    adopted.function_table = table;
    return adopted;
}

auto adopt_loaded() -> result<own_image> {
    const uptr base = own_base();
    const os::address_range allocation = LUCENT_TRY(os::allocation_containing(base));
    return own_image{
        .kind = image_kind::loaded,
        .base = base,
        .size = allocation.end - allocation.begin,
        .trampolines = 0,
        .entry = 0,
        .function_table = 0,
    };
}

}

auto adopt_image(const boot_info& info) -> result<own_image> {
    switch (info.kind) {
    case image_kind::loaded:
        return adopt_loaded();
    case image_kind::mapped:
        return adopt_mapped(info);
    }
    // The host wrote it: an unknown kind is bad input, and releasing by guess would crash later.
    return std::unexpected(error{.code = error_code::malformed});
}

auto release_module(const own_image& image) -> void {
    switch (image.kind) {
    case image_kind::loaded:
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): __ImageBase is this module's HMODULE by definition.
        FreeLibraryAndExitThread(reinterpret_cast<HMODULE>(&__ImageBase), 0);
    case image_kind::mapped:
        unmap_self(image);
    }
    // adopt_image refuses any other kind before the lifecycle thread exists.
    LUCENT_UNREACHABLE();
}

}
