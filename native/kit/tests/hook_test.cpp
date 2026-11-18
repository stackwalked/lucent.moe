#include <lucent/kit/hook.hpp>

#include <array>
#include <atomic>
#include <bit>
#include <chrono>
#include <optional>
#include <thread>
#include <tuple>
#include <utility>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

// Hooks real functions of this test process. The targets are optnone so the compiler neither
// inlines them nor folds their results into the callers: every call below reaches the patched
// bytes.

namespace lucent::kit {
namespace {

[[clang::optnone]] auto tripled(i32 value) -> i32 {
    i32 product = 0;
    for (i32 step = 0; step < 3; ++step) {
        product += value;
    }
    return product;
}

[[clang::optnone]] auto plus_three(i32 value) -> i32 {
    i32 moved = value;
    for (i32 step = 0; step < 3; ++step) {
        ++moved;
    }
    return moved;
}

auto tripled_plus_hundred(i32 (*original)(i32), i32 value) -> i32 {
    return original(value) + 100;
}

auto plus_three_negated(i32 (*original)(i32), i32 value) -> i32 {
    return -original(value);
}

// Set by a test for its length, read by the blocking handler on another thread.
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): the handler's only way to reach its test.
constinit HANDLE release_handler = nullptr;
// NOLINTNEXTLINE(cppcoreguidelines-avoid-non-const-global-variables): see release_handler.
constinit std::atomic<bool> handler_entered{false};

auto tripled_after_release(i32 (*original)(i32), i32 value) -> i32 {
    handler_entered.store(true, std::memory_order_release);
    WaitForSingleObject(release_handler, INFINITE);
    return original(value);
}

// NOLINTBEGIN(cppcoreguidelines-avoid-non-const-global-variables): hook slots are constinit globals by design.
constinit hook_slot<i32(i32)> tripled_slot{&tripled_plus_hundred};
constinit hook_slot<i32(i32)> plus_three_slot{&plus_three_negated};
constinit hook_slot<i32(i32)> blocking_slot{&tripled_after_release};
// NOLINTEND(cppcoreguidelines-avoid-non-const-global-variables)

auto address_of(i32 (*function)(i32)) -> uptr {
    return std::bit_cast<uptr>(function);
}

TEST_CASE("a hooked function runs its handler, which can call the original, until removed") {
    {
        const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
        const result<hook_set> hooks = hook_set::install(requests);
        REQUIRE(hooks.has_value());

        CHECK(tripled(2) == 106);
    }

    CHECK(tripled(2) == 6);
}

TEST_CASE("install hooks nothing when one of its targets can't be hooked") {
    // 0x06 is no instruction in 64-bit mode, so the second target can't be decoded or relocated.
    std::array<u8, 64> garbage{};
    garbage.fill(0x06);
    const std::array requests{
        hook_on<plus_three_slot>(address_of(&plus_three)),
        hook_on<tripled_slot>(std::bit_cast<uptr>(garbage.data())),
    };

    const result<hook_set> hooks = hook_set::install(requests);

    CHECK_FALSE(hooks.has_value());
    CHECK(plus_three(2) == 5);
}

TEST_CASE("removing hooks waits for calls still inside a detour") {
    release_handler = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    REQUIRE(release_handler != nullptr);
    handler_entered.store(false, std::memory_order_release);
    const std::array requests{hook_on<blocking_slot>(address_of(&tripled))};
    std::optional<hook_set> hooks;
    {
        result<hook_set> installed = hook_set::install(requests);
        REQUIRE(installed.has_value());
        hooks.emplace(std::move(*installed));
    }
    std::atomic<i32> caller_result{0};
    std::jthread caller{[&] { caller_result.store(tripled(2), std::memory_order_release); }};
    while (!handler_entered.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
    std::atomic<bool> removed{false};
    std::jthread remover{[&] {
        hooks.reset();
        removed.store(true, std::memory_order_release);
    }};

    std::this_thread::sleep_for(std::chrono::milliseconds{200});
    const bool removed_while_in_flight = removed.load(std::memory_order_acquire);
    SetEvent(release_handler);
    caller.join();
    remover.join();
    CloseHandle(release_handler);
    release_handler = nullptr;

    CHECK_FALSE(removed_while_in_flight);
    CHECK(removed.load(std::memory_order_acquire));
    CHECK(caller_result.load(std::memory_order_acquire) == 6);
    CHECK(tripled(2) == 6);
}

// Stands in for a thread caught between a detour's first instruction and its in-flight count: it
// runs in this image without being counted.
auto spin(const std::atomic<bool>& stop) -> void {
    while (!stop.load(std::memory_order_relaxed)) {
        std::atomic_signal_fence(std::memory_order_seq_cst);
    }
}

TEST_CASE("removal waits while another thread runs in this module's code, uncounted") {
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    result<hook_set> hooks = hook_set::install(requests);
    REQUIRE(hooks.has_value());
    std::atomic<bool> stop{false};
    std::jthread spinner{[&] { spin(stop); }};
    std::atomic<bool> removed{false};
    std::jthread remover{[&] {
        std::ignore = hooks->remove(unhook_patience);
        removed.store(true, std::memory_order_release);
    }};

    std::this_thread::sleep_for(std::chrono::milliseconds{200});
    const bool removed_while_spinning = removed.load(std::memory_order_acquire);
    stop.store(true, std::memory_order_relaxed);
    spinner.join();
    remover.join();

    CHECK_FALSE(removed_while_spinning);
    CHECK(removed.load(std::memory_order_acquire));
    CHECK(tripled(2) == 6);
}

TEST_CASE("removal gives up after its patience, leaving the target unpatched") {
    const std::array requests{hook_on<tripled_slot>(address_of(&tripled))};
    result<hook_set> hooks = hook_set::install(requests);
    REQUIRE(hooks.has_value());
    std::atomic<bool> stop{false};
    std::jthread spinner{[&] { spin(stop); }};

    const result<void> removed = hooks->remove(std::chrono::milliseconds{100});
    stop.store(true, std::memory_order_relaxed);
    spinner.join();

    REQUIRE_FALSE(removed.has_value());
    CHECK(removed.error().code == error_code::timed_out);
    CHECK(tripled(2) == 6);
}

}
}
