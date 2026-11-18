#include "scratch_pool.hpp"

#include <algorithm>
#include <optional>
#include <ranges>
#include <vector>

#include <lucent/core/narrow.hpp>

namespace lucent::d3d11 {

auto scratch_pool::acquire(const scratch_key& key) -> std::optional<isize> {
    for (const auto [index, candidate] : std::views::enumerate(m_entries)) {
        if (!candidate.is_in_use && candidate.key == key) {
            candidate.is_in_use = true;
            candidate.last_used = m_frame;
            return index;
        }
    }
    return std::nullopt;
}

auto scratch_pool::add(const scratch_key& key) -> isize {
    m_entries.push_back({.key = key, .last_used = m_frame, .is_in_use = true});
    return std::ssize(m_entries) - 1;
}

auto scratch_pool::release(isize entry) -> void {
    auto& released = m_entries.at(narrow<usize>(entry));
    LUCENT_INVARIANT(released.is_in_use);
    released.is_in_use = false;
    released.last_used = m_frame;
}

auto scratch_pool::key_of(isize entry) const -> const scratch_key& {
    return m_entries.at(narrow<usize>(entry)).key;
}

auto scratch_pool::next_frame() -> std::vector<isize> {
    LUCENT_INVARIANT(std::ranges::none_of(m_entries, &entry::is_in_use));
    m_frame += 1;
    std::vector<isize> evicted;
    for (isize index = std::ssize(m_entries) - 1; index >= 0; --index) {
        if (m_frame - m_entries.at(narrow<usize>(index)).last_used > scratch_lifetime) {
            evicted.push_back(index);
            m_entries.erase(m_entries.begin() + index);
        }
    }
    return evicted;
}

}
