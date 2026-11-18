#include "../src/unmap_stub.hpp"

#include <algorithm>
#include <bit>
#include <cstddef>
#include <span>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

// Runs the unmap stub's bytes on a real thread, the way a mapped module's lifecycle thread ends.

namespace lucent::kit::detail {
namespace {

auto allocate(usize size, DWORD protection) -> void* {
    void* const base = VirtualAlloc(nullptr, size, MEM_RESERVE | MEM_COMMIT, protection);
    REQUIRE(base != nullptr);
    return base;
}

auto is_free(const void* address) -> bool {
    MEMORY_BASIC_INFORMATION region{};
    REQUIRE(VirtualQuery(address, &region, sizeof(region)) != 0);
    return region.State == MEM_FREE;
}

auto kernel32_function(const char* name) -> u64 {
    const auto address =
        std::bit_cast<u64>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"), name));
    REQUIRE(address != 0);
    return address;
}

// The stub page, written as the module writes it: code, then the arguments.
auto write_stub(const unmap_args& args) -> void* {
    void* const page = allocate(unmap_page_size, PAGE_READWRITE);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // VirtualAlloc'd that size
    const std::span<std::byte> bytes{static_cast<std::byte*>(page), unmap_page_size};
#pragma clang diagnostic pop
    std::ranges::copy(std::as_bytes(std::span{unmap_stub_bytes}), bytes.begin());
    std::ranges::copy(std::as_bytes(std::span{&args, 1}), bytes.subspan(unmap_args_offset).begin());
    DWORD previous = 0;
    REQUIRE(VirtualProtect(page, unmap_page_size, PAGE_EXECUTE_READ, &previous));
    return page;
}

auto run_stub(void* page) -> DWORD {
    const auto start = std::bit_cast<LPTHREAD_START_ROUTINE>(std::bit_cast<uptr>(page));
    void* const args = std::bit_cast<void*>(std::bit_cast<uptr>(page) + unmap_args_offset);
    void* const thread = CreateThread(nullptr, 0, start, args, 0, nullptr);
    REQUIRE(thread != nullptr);
    REQUIRE(WaitForSingleObject(thread, 5000) == WAIT_OBJECT_0);
    DWORD exit_code = 0;
    GetExitCodeThread(thread, &exit_code);
    CloseHandle(thread);
    return exit_code;
}

TEST_CASE("the unmap stub frees the image and the trampolines, then ends its thread") {
    void* const image = allocate(0x3000, PAGE_READWRITE);
    void* const trampolines = allocate(0x1000, PAGE_EXECUTE_READ);
    void* const page = write_stub(
        unmap_args{
            .image = std::bit_cast<u64>(image),
            .trampolines = std::bit_cast<u64>(trampolines),
            .virtual_free = kernel32_function("VirtualFree"),
            .exit_thread = kernel32_function("ExitThread"),
            .exit_code = 7,
        }
    );

    const DWORD exit_code = run_stub(page);

    CHECK(exit_code == 7);
    CHECK(is_free(image));
    CHECK(is_free(trampolines));
    CHECK_FALSE(is_free(page));
    VirtualFree(page, 0, MEM_RELEASE);
}

TEST_CASE("the unmap stub skips the trampolines when the mapper made none") {
    void* const image = allocate(0x1000, PAGE_READWRITE);
    void* const page = write_stub(
        unmap_args{
            .image = std::bit_cast<u64>(image),
            .trampolines = 0,
            .virtual_free = kernel32_function("VirtualFree"),
            .exit_thread = kernel32_function("ExitThread"),
            .exit_code = 3,
        }
    );

    const DWORD exit_code = run_stub(page);

    CHECK(exit_code == 3);
    CHECK(is_free(image));
    VirtualFree(page, 0, MEM_RELEASE);
}

}
}
