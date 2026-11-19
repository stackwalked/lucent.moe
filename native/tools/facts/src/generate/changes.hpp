#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace lucent::facts {

// One fact whose value differs between two sets: absent before when it is new, absent after when
// it no longer resolves.
struct fact_change {
    std::string fact;
    std::optional<std::string> before;
    std::optional<std::string> after;

    auto operator==(const fact_change&) const -> bool = default;
};

// What a person signing a set looks at first: every fact that moved, by name.
struct change_report {
    std::vector<fact_change> changes;
    isize unchanged = 0;
};

// Two sets as generate writes them (facts.txt: `name=value` lines, `#` comments).
struct set_pair {
    std::string_view before;
    std::string_view after;
};

auto changes_between(set_pair sets) -> change_report;

// One line per change, then the count unchanged; each line indented two spaces.
auto describe(const change_report& report) -> std::string;

}
