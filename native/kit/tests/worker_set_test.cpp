#include <lucent/kit/worker_set.hpp>

#include <atomic>
#include <bit>
#include <expected>
#include <stop_token>
#include <thread>
#include <tuple>
#include <vector>

#include <Windows.h>

#include <catch2/catch_test_macros.hpp>

#include <lucent/core/fault.hpp>

namespace lucent::kit {
namespace {

// Each test waits on its workers through flags rather than sleeping a guessed time.
auto wait_until(const std::atomic<bool>& flag) -> void {
    while (!flag.load(std::memory_order_acquire)) {
        std::this_thread::yield();
    }
}

// A worker body: says it runs, spins until asked to stop, then says it returned.
struct spinner {
    std::atomic<bool> is_running{false};
    std::atomic<bool> has_returned{false};
};

auto spin(spinner& state, const std::stop_token& token) -> void {
    state.is_running.store(true, std::memory_order_release);
    while (!token.stop_requested()) {
        std::this_thread::yield();
    }
    state.has_returned.store(true, std::memory_order_release);
}

auto start_spinner(worker_set& workers, spinner& state) -> result<void> {
    return workers.start<"spinner">([&state](const std::stop_token& token) { spin(state, token); });
}

// A worker body that fails its ensure once it has said it started.
auto fail_ensure(std::atomic<bool>& has_started) -> void {
    has_started.store(true, std::memory_order_release);
    LUCENT_ENSURE(!has_started.load(std::memory_order_acquire));
}

}

TEST_CASE("stop trips a worker's token and returns only once its body has returned") {
    worker_set workers;
    spinner state;
    REQUIRE(start_spinner(workers, state).has_value());
    wait_until(state.is_running);

    CHECK(workers.stop().empty());
    CHECK(state.has_returned.load(std::memory_order_acquire));
}

TEST_CASE("a fault in one worker ends that worker alone and comes back from stop") {
    worker_set workers;
    spinner state;
    std::atomic<bool> has_started{false};
    REQUIRE(workers
            .start<"faulting">([&has_started](const std::stop_token&) { fail_ensure(has_started); })
            .has_value());
    REQUIRE(start_spinner(workers, state).has_value());
    wait_until(has_started);
    wait_until(state.is_running);

    const std::vector<fault> faults = workers.stop();

    REQUIRE(faults.size() == 1);
    CHECK(faults.front().kind == fault_kind::ensure_failed);
    CHECK(state.has_returned.load(std::memory_order_acquire));
}

TEST_CASE("an access violation in a worker is contained with its address") {
    void* const page = VirtualAlloc(nullptr, 4096, MEM_RESERVE | MEM_COMMIT, PAGE_NOACCESS);
    REQUIRE(page != nullptr);
    std::atomic<u32> observed{0};
    worker_set workers;

    REQUIRE(workers
            .start<"reader">([page, &observed](const std::stop_token&) {
                // Relaxed: only the read of the page matters, and it faults first.
                observed.store(*static_cast<const u32*>(page), std::memory_order_relaxed);
            })
            .has_value());
    const std::vector<fault> faults = workers.stop();
    VirtualFree(page, 0, MEM_RELEASE);

    REQUIRE(faults.size() == 1);
    CHECK(faults.front().kind == fault_kind::access_violation);
    CHECK(faults.front().address == std::bit_cast<uptr>(page));
}

TEST_CASE("a worker started once stop has begun is refused") {
    worker_set workers;
    std::ignore = workers.stop();

    const result<void> started = workers.start<"late">([](const std::stop_token&) {});

    CHECK(started == std::unexpected(error{.code = error_code::closed}));
}

TEST_CASE("destroying the set joins workers that stop was never called for") {
    spinner state;
    {
        worker_set workers;
        REQUIRE(start_spinner(workers, state).has_value());
        wait_until(state.is_running);
    }

    CHECK(state.has_returned.load(std::memory_order_acquire));
}

}
