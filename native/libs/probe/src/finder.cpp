#include <lucent/probe/finder.hpp>

#include <algorithm>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <vector>

#include <lucent/core/narrow.hpp>
#include <lucent/probe/finding.hpp>

namespace lucent::probe {

auto flaw_of(std::span<const finder> finders) -> std::optional<finder_set_flaw> {
    if (finders.empty()) {
        return finder_set_flaw::empty;
    }
    const bool has_shape = std::ranges::contains(finders, basis::shape, &finder::rests_on);
    if (has_shape && finders.size() < 2) {
        return finder_set_flaw::lone_shape;
    }
    const bool has_unexplained = std::ranges::any_of(finders, [](const finder& each) {
        return each.rests_on == basis::bytes && each.reason.empty();
    });
    if (has_unexplained) {
        return finder_set_flaw::unexplained_bytes;
    }
    return std::nullopt;
}

auto agree(std::span<const finding> findings) -> std::expected<agreement, disagreement> {
    std::optional<u64> value;
    agreement settled;
    for (const auto [index, found] : std::views::enumerate(findings)) {
        if (!found) {
            settled.failed.push_back(narrow<isize>(index));
            continue;
        }
        if (value && *value != *found) {
            return std::unexpected(disagreement::conflict);
        }
        value = *found;
        settled.agreed.push_back(narrow<isize>(index));
    }
    if (!value) {
        return std::unexpected(disagreement::unresolved);
    }
    settled.value = *value;
    return settled;
}

}
