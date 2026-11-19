#include <lucent/probe/finder.hpp>

#include <array>
#include <expected>
#include <optional>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/probe/code_index.hpp>
#include <lucent/probe/finding.hpp>
#include <lucent/probe/module_file.hpp>

namespace lucent::probe {
namespace {

auto nothing(const module_file& /*module*/, const code_index& /*index*/) -> finding {
    return std::unexpected(miss::none);
}

TEST_CASE("a search with one distinct value finds it, however many sites hold it") {
    CHECK(one(std::array<u64, 3>{0x40, 0x40, 0x40}) == finding{0x40});
    CHECK(one(std::array<u32, 1>{7}) == finding{7});
}

TEST_CASE("a search with no candidates misses with none") {
    CHECK(one(std::vector<u64>{}) == finding{std::unexpected(miss::none)});
}

TEST_CASE("a search with two distinct values misses as ambiguous, whichever comes first") {
    CHECK(one(std::array<u64, 3>{0x40, 0x40, 0x80}) == finding{std::unexpected(miss::ambiguous)});
    CHECK(one(std::array<u32, 2>{2, 1}) == finding{std::unexpected(miss::ambiguous)});
}

TEST_CASE("finders that agree settle the fact, and one that found nothing is named beside them") {
    const std::array findings{
        finding{0x1000},
        finding{std::unexpected(miss::ambiguous)},
        finding{0x1000},
    };

    const std::expected<agreement, disagreement> settled = agree(findings);
    REQUIRE(settled.has_value());
    CHECK(settled->value == 0x1000);
    CHECK(settled->agreed == std::vector<isize>{0, 2});
    CHECK(settled->failed == std::vector<isize>{1});
}

TEST_CASE("finders that settle on different values leave the fact in conflict") {
    const std::array findings{
        finding{0x1000},
        finding{std::unexpected(miss::none)},
        finding{0x2000},
    };

    CHECK(agree(findings) == std::unexpected(disagreement::conflict));
}

TEST_CASE("a fact none of whose finders settled on a value is unresolved") {
    const std::array findings{
        finding{std::unexpected(miss::none)},
        finding{std::unexpected(miss::ambiguous)},
    };

    CHECK(agree(findings) == std::unexpected(disagreement::unresolved));
    CHECK(agree(std::vector<finding>{}) == std::unexpected(disagreement::unresolved));
}

TEST_CASE("a shape finder needs a second finder, and a byte pattern must say why it's needed") {
    constexpr finder semantic{
        .name = "string",
        .rests_on = basis::semantic,
        .reason = "",
        .run = &nothing,
    };
    constexpr finder shape{.name = "body", .rests_on = basis::shape, .reason = "", .run = &nothing};
    constexpr finder bytes{
        .name = "bytes",
        .rests_on = basis::bytes,
        .reason = "",
        .run = &nothing,
    };
    constexpr finder explained{
        .name = "bytes",
        .rests_on = basis::bytes,
        .reason = "nothing names it",
        .run = &nothing,
    };

    CHECK(flaw_of(std::array{semantic}) == std::nullopt);
    CHECK(flaw_of(std::array{shape}) == finder_set_flaw::lone_shape);
    CHECK(flaw_of(std::array{shape, semantic}) == std::nullopt);
    CHECK(flaw_of(std::array{shape, shape}) == std::nullopt);
    CHECK(flaw_of(std::array{bytes}) == finder_set_flaw::unexplained_bytes);
    CHECK(flaw_of(std::array{explained}) == std::nullopt);
    CHECK(flaw_of(std::vector<finder>{}) == finder_set_flaw::empty);
}

}
}
