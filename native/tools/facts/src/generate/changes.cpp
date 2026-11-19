#include "generate/changes.hpp"

#include <flat_map>
#include <format>
#include <optional>
#include <ranges>
#include <string>
#include <string_view>

namespace lucent::facts {
namespace {

auto values_in(std::string_view text) -> std::flat_map<std::string, std::string> {
    std::flat_map<std::string, std::string> values;
    for (const auto line : text | std::views::split('\n')) {
        std::string_view entry{line};
        if (entry.ends_with('\r')) {
            entry.remove_suffix(1);
        }
        const usize equals = entry.find('=');
        if (entry.empty() || entry.starts_with('#') || equals == std::string_view::npos) {
            continue;
        }
        values.insert_or_assign(
            std::string{entry.substr(0, equals)}, std::string{entry.substr(equals + 1)}
        );
    }
    return values;
}

}

auto changes_between(set_pair sets) -> change_report {
    const std::flat_map<std::string, std::string> old_values = values_in(sets.before);
    const std::flat_map<std::string, std::string> new_values = values_in(sets.after);
    change_report report;
    for (const auto [fact, value] : new_values) {
        const auto old_value = old_values.find(fact);
        if (old_value == old_values.end()) {
            report.changes.push_back({.fact = fact, .before = std::nullopt, .after = value});
        } else if (old_value->second != value) {
            report.changes.push_back({.fact = fact, .before = old_value->second, .after = value});
        } else {
            ++report.unchanged;
        }
    }
    for (const auto [fact, value] : old_values) {
        if (!new_values.contains(fact)) {
            report.changes.push_back({.fact = fact, .before = value, .after = std::nullopt});
        }
    }
    return report;
}

auto describe(const change_report& report) -> std::string {
    std::string text;
    for (const fact_change& change : report.changes) {
        if (!change.before) {
            text += std::format("  added    {:<26} {}\n", change.fact, change.after.value_or(""));
        } else if (!change.after) {
            text += std::format("  removed  {:<26} {}\n", change.fact, *change.before);
        } else {
            text += std::format(
                "  changed  {:<26} {} -> {}\n", change.fact, *change.before, *change.after
            );
        }
    }
    text += std::format("  {} unchanged\n", report.unchanged);
    return text;
}

}
