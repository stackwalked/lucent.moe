#include "release.hpp"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <expected>
#include <optional>
#include <source_location>
#include <span>

#include <Windows.h>

#include <lucent/kit/boot_info.hpp>
#include <lucent/os/address_range.hpp>
#include <lucent/pe/image_view.hpp>

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

// Everything unmapping needs, worked out while the CRT still runs.
struct unmap_plan {
    entry_point entry = nullptr;
    // Null when the image has no .pdata.
    RUNTIME_FUNCTION* function_table = nullptr;
    std::byte* stub_page = nullptr;
};

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

auto plan_unmap(u64 trampolines) -> result<unmap_plan> {
    const uptr base = own_base();
    const os::address_range image = LUCENT_TRY(os::allocation_containing(base));
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // our own mapped image
    const std::span<const std::byte> bytes{
        std::bit_cast<const std::byte*>(base), image.end - image.begin
    };
#pragma clang diagnostic pop
    const pe::image_view view = LUCENT_TRY(pe::image_view::parse(bytes, pe::layout::mapped));
    const std::optional<pe::directory> exceptions =
        view.find_directory(pe::directory_kind::exceptions);
    const u64 virtual_free = LUCENT_TRY(kernel32_function("VirtualFree"));
    const u64 exit_thread = LUCENT_TRY(kernel32_function("ExitThread"));
    std::byte* const page = LUCENT_TRY(write_stub(
        unmap_args{
            .image = base,
            .trampolines = trampolines,
            .virtual_free = virtual_free,
            .exit_thread = exit_thread,
            .exit_code = 0,
        }
    ));
    return unmap_plan{
        .entry = std::bit_cast<entry_point>(base + view.entry_point()),
        .function_table = exceptions.has_value()
                              ? std::bit_cast<RUNTIME_FUNCTION*>(base + exceptions->rva)
                              : nullptr,
        .stub_page = page,
    };
}

[[noreturn]] auto unmap_self(u64 trampolines) -> void {
    const result<unmap_plan> plan = plan_unmap(trampolines);
    if (!plan) {
        // Mapped and inert is safe; freeing an image we couldn't read the shape of isn't.
        ExitThread(0);
    }
    // The CRT's teardown: static destructors, atexit, and its FLS index, whose callback lives in
    // this image and would otherwise run at every later thread exit. No CRT after this line.
    plan->entry(std::bit_cast<HINSTANCE>(own_base()), DLL_PROCESS_DETACH, nullptr);
    if (plan->function_table != nullptr) {
        RtlDeleteFunctionTable(plan->function_table);
    }
    const auto page = std::bit_cast<uptr>(plan->stub_page);
    const auto stub = std::bit_cast<unmap_stub>(page);
    stub(std::bit_cast<const unmap_args*>(page + unmap_args_offset));
    // The stub ends the thread; reaching here means its bytes are wrong.
    invariant_violated(std::source_location::current());
}

}

auto release_module(image_kind kind, u64 trampolines) -> void {
    switch (kind) {
    case image_kind::loaded:
        // NOLINTNEXTLINE(cppcoreguidelines-pro-type-reinterpret-cast): __ImageBase is this module's HMODULE by definition.
        FreeLibraryAndExitThread(reinterpret_cast<HMODULE>(&__ImageBase), 0);
    case image_kind::mapped:
        unmap_self(trampolines);
    }
    // kit::start refuses any other kind before the lifecycle thread exists.
    invariant_violated(std::source_location::current());
}

}
