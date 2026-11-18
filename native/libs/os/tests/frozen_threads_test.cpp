#include <lucent/os/frozen_threads.hpp>

#include <algorithm>
#include <atomic>
#include <bit>
#include <thread>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/os/address_range.hpp>

namespace lucent::os {
namespace {

// Spins until told to stop, counting its turns. Everything it runs is this test's own code (in a
// Debug build std::atomic's members are out-of-line functions here too), never a system DLL.
auto spin(const std::atomic<bool>& stop, std::atomic<u64>& turns) -> void {
    while (!stop.load(std::memory_order_relaxed)) {
        turns.fetch_add(1, std::memory_order_relaxed);
    }
}

// While anything is frozen, nothing here allocates: Catch2's checks run after the thaw.
TEST_CASE("a frozen thread makes no progress until thawed, and is caught where it runs") {
    std::atomic<bool> stop{false};
    std::atomic<u64> turns{0};
    const std::jthread worker{[&] { spin(stop, turns); }};
    while (turns.load(std::memory_order_relaxed) == 0) {
        std::this_thread::yield();
    }
    const result<address_range> test_image = allocation_containing(std::bit_cast<uptr>(&spin));
    REQUIRE(test_image.has_value());
    u64 turns_at_freeze = 0;
    u64 turns_after_wait = 0;
    bool is_caught_spinning = false;

    {
        const result<frozen_threads> frozen = frozen_threads::freeze_others();
        REQUIRE(frozen.has_value());
        turns_at_freeze = turns.load(std::memory_order_relaxed);
        Sleep(50);
        turns_after_wait = turns.load(std::memory_order_relaxed);
        is_caught_spinning = std::ranges::any_of(frozen->instruction_pointers(), [&](uptr where) {
            return contains(*test_image, where);
        });
    }
    Sleep(50);
    const u64 turns_after_thaw = turns.load(std::memory_order_relaxed);
    stop.store(true, std::memory_order_relaxed);

    CHECK(turns_after_wait == turns_at_freeze);
    CHECK(is_caught_spinning);
    CHECK(turns_after_thaw > turns_after_wait);
}

TEST_CASE("an allocation's range spans its regions, whatever their protection") {
    constexpr usize page = 4096;
    void* const base = VirtualAlloc(nullptr, 3 * page, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    REQUIRE(base != nullptr);
    const auto begin = std::bit_cast<uptr>(base);
    DWORD previous = 0;
    REQUIRE(VirtualProtect(std::bit_cast<void*>(begin + page), page, PAGE_READONLY, &previous));

    const result<address_range> range = allocation_containing(begin + (2 * page) + 8);

    REQUIRE(range.has_value());
    CHECK(*range == address_range{.begin = begin, .end = begin + (3 * page)});
    VirtualFree(base, 0, MEM_RELEASE);
}

TEST_CASE("the allocation holding this test's code is its image") {
    const auto image = std::bit_cast<uptr>(GetModuleHandleW(nullptr));

    const result<address_range> range = allocation_containing(std::bit_cast<uptr>(&spin));

    REQUIRE(range.has_value());
    CHECK(range->begin == image);
    CHECK(range->end > std::bit_cast<uptr>(&spin));
}

}
}
