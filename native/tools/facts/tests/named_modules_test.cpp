#include "targets/named_modules.hpp"

#include <array>
#include <ranges>
#include <string_view>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/game_module.hpp>

namespace lucent::facts {
namespace {

constexpr std::array table{
    kit::game_module{.index = 1, .name = "client.dll"},
    kit::game_module{.index = 2, .name = "engine2.dll"},
    kit::game_module{.index = 3, .name = "schemasystem.dll"},
};

auto fact_in(u8 module) -> kit::fact_record {
    return kit::fact_record{.key = 0x1234, .kind = kit::fact_kind::global, .module = module};
}

auto names_of(const std::vector<kit::game_module>& modules) -> std::vector<std::string_view> {
    return modules
           | std::views::transform(&kit::game_module::name)
           | std::ranges::to<std::vector<std::string_view>>();
}

}

TEST_CASE("only the game modules a built module's facts name are in the pipeline") {
    const std::array facts{fact_in(3), fact_in(1), fact_in(3)};

    CHECK(
        names_of(modules_named(facts, table))
        == std::vector<std::string_view>{"client.dll", "schemasystem.dll"}
    );
}

TEST_CASE("a module whose facts are all stripped drops out of the pipeline") {
    CHECK(modules_named({}, table).empty());
}

TEST_CASE("a fact naming a module the target's table lacks names no module") {
    const std::array facts{fact_in(9)};

    CHECK(modules_named(facts, table).empty());
}

}
