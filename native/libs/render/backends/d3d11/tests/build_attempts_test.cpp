#include "../src/build_attempts.hpp"

#include <catch2/catch_test_macros.hpp>

#include <lucent/d3d11/renderer.hpp>

namespace lucent::d3d11 {
namespace {

auto failed_times(isize failures) -> build_attempts {
    build_attempts attempts;
    for (isize i = 0; i < failures; ++i) {
        attempts.start();
        attempts.fail();
    }
    return attempts;
}

TEST_CASE("a failed build leaves the renderer idle to be tried again, twice") {
    const build_attempts once = failed_times(1);
    const build_attempts twice = failed_times(2);

    CHECK(once.state() == renderer_state::idle);
    CHECK(once.can_start());
    CHECK(twice.state() == renderer_state::idle);
    CHECK(twice.can_start());
}

TEST_CASE("the third failed build leaves the renderer failed for good") {
    const build_attempts attempts = failed_times(3);

    CHECK(attempts.state() == renderer_state::failed);
    CHECK_FALSE(attempts.can_start());
}

TEST_CASE("a build that succeeds after failures is ready and starts no more") {
    build_attempts attempts = failed_times(2);
    attempts.start();
    CHECK(attempts.state() == renderer_state::building);
    CHECK_FALSE(attempts.can_start());

    attempts.succeed();

    CHECK(attempts.state() == renderer_state::ready);
    CHECK_FALSE(attempts.can_start());
}

}
}
