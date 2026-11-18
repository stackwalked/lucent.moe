#include "../src/scratch_pool.hpp"

#include <optional>
#include <vector>

#include <catch2/catch_test_macros.hpp>

namespace lucent::d3d11 {
namespace {

constexpr u32 rgba = 28;
constexpr u32 bgra = 87;
constexpr scratch_key small{.width = 64, .height = 64, .format = rgba};
constexpr scratch_key wide{.width = 128, .height = 64, .format = rgba};

auto aged(scratch_pool& pool, i64 frames) -> std::vector<isize> {
    std::vector<isize> evicted;
    for (i64 i = 0; i < frames; ++i) {
        evicted.append_range(pool.next_frame());
    }
    return evicted;
}

TEST_CASE("sizes round up to 64 pixel buckets, so a growing pane keeps one surface") {
    CHECK(bucketed({.width = 100, .height = 30}).width == 128);
    CHECK(bucketed({.width = 100, .height = 30}).height == 64);
    CHECK(bucketed({.width = 128, .height = 129}).width == 128);
    CHECK(bucketed({.width = 128, .height = 129}).height == 192);
}

TEST_CASE("a released surface is handed out again for the same key, never for another") {
    scratch_pool pool;
    const isize made = pool.add(small);
    pool.release(made);

    CHECK_FALSE(pool.acquire(wide).has_value());
    CHECK_FALSE(pool.acquire({.width = 64, .height = 64, .format = bgra}).has_value());
    CHECK(pool.acquire(small) == made);
}

TEST_CASE("a surface in use is never handed out twice") {
    scratch_pool pool;
    const isize held = pool.add(small);

    CHECK_FALSE(pool.acquire(small).has_value());
    CHECK(pool.key_of(held) == small);
}

TEST_CASE("a surface unused for 240 frames stays and on the 241st is evicted") {
    scratch_pool pool;
    pool.release(pool.add(small));

    CHECK(aged(pool, 240).empty());
    CHECK(aged(pool, 1) == std::vector<isize>{0});
    CHECK_FALSE(pool.acquire(small).has_value());
}

TEST_CASE("evictions come highest index first, and a surface used meanwhile stays") {
    scratch_pool pool;
    const isize first = pool.add(small);
    const isize second = pool.add(wide);
    const isize third = pool.add({.width = 64, .height = 128, .format = rgba});
    pool.release(first);
    pool.release(second);
    pool.release(third);
    CHECK(aged(pool, 200).empty());
    const std::optional<isize> reused = pool.acquire(wide);
    REQUIRE(reused == second);
    pool.release(second);

    CHECK(aged(pool, 41) == std::vector<isize>{2, 0});
    CHECK(pool.key_of(0) == wide);
}

}
}
