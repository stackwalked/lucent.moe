#include <lucent/kit/handoff.hpp>

#include <algorithm>
#include <memory>
#include <optional>
#include <stop_token>
#include <thread>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/worker_set.hpp>
#include <lucent/testing/invariant_violation.hpp>

// A handoff that let a value be taken twice, or taken half-written, would hand the presenting
// thread a renderer some other thread still builds.

namespace lucent::kit {

TEST_CASE("a handoff gives nothing before its value is given") {
    handoff<i32> landing;

    CHECK_FALSE(landing.take().has_value());
}

TEST_CASE("a handoff's value is taken once and then never again") {
    handoff<std::unique_ptr<i32>> landing;
    landing.give(std::make_unique<i32>(7));

    const std::unique_ptr<i32> first = landing.take().value_or(nullptr);

    REQUIRE(first != nullptr);
    CHECK(*first == 7);
    CHECK_FALSE(landing.take().has_value());
}

TEST_CASE("a value made on a worker arrives whole on the thread that takes it") {
    constexpr isize length = 100'000;
    handoff<std::vector<i32>> landing;
    worker_set workers;
    REQUIRE(workers
            .start<"producer">([&landing](const std::stop_token&) {
                std::vector<i32> made(static_cast<usize>(length), 0);
                for (i32& element : made) {
                    element = 3;
                }
                landing.give(std::move(made));
            })
            .has_value());

    std::optional<std::vector<i32>> taken;
    while (!taken) {
        taken = landing.take();
        std::this_thread::yield();
    }

    CHECK(std::ssize(*taken) == length);
    CHECK(std::ranges::all_of(*taken, [](i32 element) { return element == 3; }));
    CHECK(workers.stop().empty());
}

TEST_CASE("giving a handoff a second value is our own bug") {
    handoff<i32> landing;
    landing.give(1);

    CHECK_THROWS_AS(landing.give(2), testing::invariant_violation);
}

}
