#include <lucent/kit/published.hpp>

#include <algorithm>
#include <atomic>
#include <functional>
#include <optional>
#include <thread>
#include <vector>

#include <catch2/catch_test_macros.hpp>

// The safe point swaps whole snapshots under readers on other threads: a reader that saw half of
// one would act on a state no safe point ever made.

namespace lucent::kit {
namespace {

// Every element equal: a mix of two publishes shows as two values side by side.
auto uniform(i32 value) -> std::vector<i32> {
    return std::vector<i32>(64, value);
}

auto is_uniform(const std::vector<i32>& values) -> bool {
    return std::ranges::adjacent_find(values, std::ranges::not_equal_to{}) == values.end();
}

struct read_failures {
    std::atomic<i32> torn{0};
    std::atomic<i32> backwards{0};
};

// Reads until told to stop, counting values that were mixed or older than one already seen.
auto read_until(
    published<std::vector<i32>>& shared, const std::atomic<bool>& is_done, read_failures& failed
) -> void {
    i32 last = 0;
    while (!is_done.load(std::memory_order_acquire)) {
        const published<std::vector<i32>>::reading seen = shared.read();
        if (!is_uniform(*seen)) {
            failed.torn.fetch_add(1, std::memory_order_relaxed);
        }
        if (seen->front() < last) {
            failed.backwards.fetch_add(1, std::memory_order_relaxed);
        }
        last = seen->front();
    }
}

}

TEST_CASE("readers on other threads see only whole published values while a writer publishes") {
    published<std::vector<i32>> shared{uniform(0)};
    std::atomic<bool> is_done{false};
    read_failures failed;
    std::vector<std::jthread> readers;
    readers.reserve(3);
    for (isize index = 0; index < 3; ++index) {
        readers.emplace_back([&] { read_until(shared, is_done, failed); });
    }

    i32 landed = 0;
    for (i32 next = 1; next <= 20'000; ++next) {
        if (!shared.publish(uniform(next)).has_value()) {
            landed = next;
        }
    }
    is_done.store(true, std::memory_order_release);
    readers.clear();

    CHECK(failed.torn.load(std::memory_order_relaxed) == 0);
    CHECK(failed.backwards.load(std::memory_order_relaxed) == 0);
    CHECK(shared.read()->front() == landed);
}

TEST_CASE("a publish while every other slot is being read hands its value back") {
    published<i32> shared{1};
    // Each reading pins the slot that was current when it was taken.
    const published<i32>::reading first = shared.read();
    REQUIRE_FALSE(shared.publish(2).has_value());
    const published<i32>::reading second = shared.read();
    REQUIRE_FALSE(shared.publish(3).has_value());
    const published<i32>::reading third = shared.read();

    const std::optional<i32> refused = shared.publish(4);

    CHECK(refused == 4);
    CHECK(*first == 1);
    CHECK(*second == 2);
    CHECK(*third == 3);
    CHECK(*shared.read() == 3);
}

}
