#include "../src/stubs.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <span>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

// Exercises the two stubs' bytes in this process: allocates an RWX page, writes the bytes to it,
// calls them with recording fakes in place of RtlAddFunctionTable, the module entry point and the
// real RtlPcToFileHeader.

namespace lucent::manualmap {
namespace {

struct recording {
    u64 function_table = 0;
    u64 function_count = 0;
    u64 add_image_base = 0;
    i32 add_calls = 0;
    u8 add_result = 1; // TRUE

    u64 entry_instance = 0;
    u32 entry_reason = 0;
    u64 entry_reserved = 0;
    i32 entry_calls = 0;
    uptr entry_rsp_on_entry = 0;

    u64 original_pc = 0;
    u64 original_base_out = 0;
};

// Set by active_recording for the length of a test, cleared on scope exit.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the C-ABI fakes reach their test's recording through this pointer.
constinit recording* active = nullptr;

class active_recording final {
public:
    explicit active_recording(recording& record) {
        active = &record;
    }

    active_recording(const active_recording&) = delete ("scope-bound");
    auto operator=(const active_recording&) -> active_recording& = delete ("scope-bound");
    active_recording(active_recording&&) = delete ("scope-bound");
    auto operator=(active_recording&&) -> active_recording& = delete ("scope-bound");

    ~active_recording() {
        active = nullptr;
    }
};

extern "C" {
// NOLINTBEGIN(bugprone-easily-swappable-parameters,readability-identifier-length): mirrors Win32 signatures.
auto fake_add_function_table(void* table, DWORD count, DWORD64 image_base) -> BOOLEAN;
auto fake_entry_point(HINSTANCE instance, DWORD reason, void* reserved) -> BOOL;
auto fake_original_rtl_pc(void* pc, void** base_out) -> void*;
// NOLINTEND(bugprone-easily-swappable-parameters,readability-identifier-length)
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters,readability-identifier-length): mirrors Win32 signature.
extern "C" auto fake_add_function_table(void* table, DWORD count, DWORD64 image_base) -> BOOLEAN {
    ++active->add_calls;
    active->function_table = std::bit_cast<u64>(table);
    active->function_count = count;
    active->add_image_base = image_base;
    return active->add_result;
}

extern "C" auto fake_entry_point(HINSTANCE instance, DWORD reason, void* reserved) -> BOOL {
    ++active->entry_calls;
    // At a callee's first instruction rsp is 8 mod 16 (the return address was just pushed).
    active->entry_rsp_on_entry = std::bit_cast<uptr>(_AddressOfReturnAddress());
    active->entry_instance = std::bit_cast<u64>(instance);
    active->entry_reason = reason;
    active->entry_reserved = std::bit_cast<u64>(reserved);
    return TRUE;
}

// NOLINTNEXTLINE(readability-identifier-length): mirrors Win32 signature.
extern "C" auto fake_original_rtl_pc(void* pc, void** base_out) -> void* {
    active->original_pc = std::bit_cast<u64>(pc);
    active->original_base_out = std::bit_cast<u64>(base_out);
    return std::bit_cast<void*>(uptr{0x5151});
}

class rwx_page final {
public:
    rwx_page() {
        void* const raw =
            VirtualAlloc(nullptr, page_size, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
        REQUIRE(raw != nullptr);
        m_data = static_cast<std::byte*>(raw);
    }

    rwx_page(const rwx_page&) = delete ("one owner");
    auto operator=(const rwx_page&) -> rwx_page& = delete ("one owner");
    rwx_page(rwx_page&&) = delete ("not needed");
    auto operator=(rwx_page&&) -> rwx_page& = delete ("not needed");

    ~rwx_page() {
        VirtualFree(m_data, 0, MEM_RELEASE);
    }

    // VirtualAlloc gave us exactly page_size bytes.
    auto bytes() const -> std::span<std::byte> {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container"
        return {m_data, page_size};
#pragma clang diagnostic pop
    }

    auto data() const -> std::byte* {
        return m_data;
    }

private:
    static constexpr usize page_size = 0x1000;
    std::byte* m_data = nullptr;
};

template <typename Function>
auto function_at(const rwx_page& page) -> Function {
    // NOLINTNEXTLINE(bugprone-bitwise-pointer-cast): no standard cast from a data pointer to a function pointer; bit_cast is the dialect's reinterpret_cast.
    return std::bit_cast<Function>(page.data());
}

// NOLINTNEXTLINE(bugprone-easily-swappable-parameters): the offset and the value really are both u64 here; introducing a strong type for one callee isn't worth it.
auto write_u64_at(std::span<std::byte> bytes, usize offset, u64 value) -> void {
    const auto raw = std::bit_cast<std::array<std::byte, 8>>(value);
    std::ranges::copy(raw, bytes.subspan(offset).begin());
}

auto load_attach_stub(const rwx_page& page) -> void {
    std::ranges::copy(std::as_bytes(std::span{detail::attach_stub_bytes}), page.bytes().begin());
}

auto load_trampoline(const rwx_page& page, u64 image_base, u64 image_end, u64 original) -> void {
    std::ranges::copy(
        std::as_bytes(std::span{detail::rtl_pc_trampoline_bytes}), page.bytes().begin()
    );
    write_u64_at(page.bytes(), detail::trampoline_image_base_offset, image_base);
    write_u64_at(page.bytes(), detail::trampoline_image_end_offset, image_end);
    write_u64_at(page.bytes(), detail::trampoline_original_offset, original);
}

using attach_fn = DWORD (*)(const detail::attach_args*);
using pc_fn = void* (*)(void*, void**);

}

TEST_CASE("attach_stub registers the exception table and calls the entry point") {
    recording record;
    const active_recording guard{record};
    const rwx_page page;
    load_attach_stub(page);
    const detail::attach_args args{
        .function_table = 0x1000,
        .function_count = 3,
        .image_base = 0x7ff0'0000'0000ULL,
        .add_function_table = std::bit_cast<u64>(&fake_add_function_table),
        .entry_point = std::bit_cast<u64>(&fake_entry_point),
        .reserved = 0xabc,
    };

    CHECK(function_at<attach_fn>(page)(&args) == 1);
    CHECK(record.add_calls == 1);
    CHECK(record.function_table == 0x1000);
    CHECK(record.function_count == 3);
    CHECK(record.add_image_base == 0x7ff0'0000'0000ULL);
    CHECK(record.entry_calls == 1);
    CHECK(record.entry_instance == 0x7ff0'0000'0000ULL);
    CHECK(record.entry_reason == DLL_PROCESS_ATTACH);
    CHECK(record.entry_reserved == 0xabc);
    CHECK(record.entry_rsp_on_entry % 16 == 8);
}

TEST_CASE("attach_stub skips registration when the exception table is empty") {
    recording record;
    const active_recording guard{record};
    const rwx_page page;
    load_attach_stub(page);
    const detail::attach_args args{
        .function_table = 0,
        .function_count = 0,
        .image_base = 0x7ff0'0000'0000ULL,
        .add_function_table = std::bit_cast<u64>(&fake_add_function_table),
        .entry_point = std::bit_cast<u64>(&fake_entry_point),
        .reserved = 0,
    };

    CHECK(function_at<attach_fn>(page)(&args) == 1);
    CHECK(record.add_calls == 0);
    CHECK(record.entry_calls == 1);
}

TEST_CASE("attach_stub returns 2 when RtlAddFunctionTable rejects the table") {
    recording record{.add_result = 0};
    const active_recording guard{record};
    const rwx_page page;
    load_attach_stub(page);
    const detail::attach_args args{
        .function_table = 0x1000,
        .function_count = 3,
        .image_base = 0x7ff0'0000'0000ULL,
        .add_function_table = std::bit_cast<u64>(&fake_add_function_table),
        .entry_point = std::bit_cast<u64>(&fake_entry_point),
        .reserved = 0,
    };

    CHECK(function_at<attach_fn>(page)(&args) == 2);
    CHECK(record.add_calls == 1);
    CHECK(record.entry_calls == 0);
}

TEST_CASE("rtl_pc_trampoline answers inside the image's range") {
    recording record;
    const active_recording guard{record};
    const rwx_page page;
    constexpr u64 image_base = 0x7ff0'0000'0000ULL;
    constexpr u64 image_end = 0x7ff0'0001'0000ULL;
    load_trampoline(page, image_base, image_end, std::bit_cast<u64>(&fake_original_rtl_pc));
    const auto trampoline = function_at<pc_fn>(page);

    void* base_out = nullptr;
    void* const inside = std::bit_cast<void*>(uptr{0x7ff0'0000'1234ULL});
    CHECK(trampoline(inside, &base_out) == std::bit_cast<void*>(image_base));
    CHECK(base_out == std::bit_cast<void*>(image_base));
    CHECK(record.original_pc == 0);

    CHECK(trampoline(inside, nullptr) == std::bit_cast<void*>(image_base));
    CHECK(record.original_pc == 0);
}

TEST_CASE("rtl_pc_trampoline forwards addresses outside the image to the real function") {
    recording record;
    const active_recording guard{record};
    const rwx_page page;
    constexpr u64 image_base = 0x7ff0'0000'0000ULL;
    constexpr u64 image_end = 0x7ff0'0001'0000ULL;
    load_trampoline(page, image_base, image_end, std::bit_cast<u64>(&fake_original_rtl_pc));
    const auto trampoline = function_at<pc_fn>(page);

    void* base_out = nullptr;
    void* const above = std::bit_cast<void*>(image_end);
    CHECK(trampoline(above, &base_out) == std::bit_cast<void*>(uptr{0x5151}));
    CHECK(record.original_pc == image_end);
    CHECK(record.original_base_out == std::bit_cast<u64>(&base_out));

    void* const below = std::bit_cast<void*>(uptr{0x1000});
    CHECK(trampoline(below, nullptr) == std::bit_cast<void*>(uptr{0x5151}));
    CHECK(record.original_pc == std::bit_cast<u64>(below));
    CHECK(record.original_base_out == 0);
}

}
