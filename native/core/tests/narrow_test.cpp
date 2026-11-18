#include <lucent/core/narrow.hpp>

#include <utility>

#include <catch2/catch_test_macros.hpp>

#include <lucent/testing/invariant_violation.hpp>

namespace lucent {

static_assert(narrow<u8>(i32{255}) == 255, "a value the target can hold survives");
static_assert(narrow<i8>(i64{-128}) == -128, "the target's minimum survives");
static_assert(narrow<u64>(i32{0}) == 0, "zero crosses signedness");
static_assert(narrow<isize>(usize{42}) == 42, "sizes convert to signed counts");

TEST_CASE("narrow fails the invariant when the value does not fit") {
    CHECK_THROWS_AS(std::ignore = narrow<u8>(i32{256}), testing::invariant_violation);
    CHECK_THROWS_AS(std::ignore = narrow<i8>(i32{-129}), testing::invariant_violation);
}

TEST_CASE("narrow fails the invariant when the sign would flip") {
    CHECK_THROWS_AS(std::ignore = narrow<u32>(i32{-1}), testing::invariant_violation);
    CHECK_THROWS_AS(std::ignore = narrow<i64>(u64{1} << 63U), testing::invariant_violation);
}

}
