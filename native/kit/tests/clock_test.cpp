#include <lucent/kit/clock.hpp>

#include <chrono>

#include <catch2/catch_test_macros.hpp>

#include <lucent/testing/invariant_violation.hpp>

// Every clock-driven test leans on test_clock: if it drifted or lost a step, those tests would
// pass or fail for the wrong reason.

namespace lucent::kit {

TEST_CASE("a test clock stands still until advanced, then moves by exactly the step") {
    test_clock time;
    const clock::time_point start = time.now();

    CHECK(time.now() == start);
    time.advance(std::chrono::milliseconds{250});
    time.advance(std::chrono::nanoseconds{1});

    CHECK(time.now() - start == std::chrono::milliseconds{250} + std::chrono::nanoseconds{1});
}

TEST_CASE("a test clock read through the interface is the one the test steps") {
    test_clock time;
    const clock& injected = time;

    time.advance(std::chrono::seconds{3});

    CHECK(injected.now().time_since_epoch() == std::chrono::seconds{3});
}

TEST_CASE("a test clock refuses to go backwards") {
    test_clock time;

    CHECK_THROWS_AS(time.advance(std::chrono::nanoseconds{-1}), testing::invariant_violation);
}

}
