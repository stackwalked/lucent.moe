#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <ranges>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include <lucent/probe/module_file.hpp>

namespace lucent::probe {

// Bytes of code where some are unknown, written as hex pairs and "??" wildcards separated by
// spaces: "48 8B 05 ?? ?? ?? ??". Malformed text doesn't compile.
class byte_pattern final {
public:
    static constexpr isize max_size = 64;

    consteval explicit byte_pattern(std::string_view text) noexcept {
        for (const auto token : text | std::views::split(' ')) {
            const std::string_view pair{token};
            if (pair.empty()) {
                continue;
            }
            LUCENT_INVARIANT(pair.size() == 2 && m_size < max_size);
            const auto index = static_cast<usize>(m_size);
            if (pair != "??") {
                m_bytes.at(index) =
                    static_cast<u8>((nibble(pair.front()) << 4U) | nibble(pair.back()));
                m_is_known.at(index) = true;
            }
            ++m_size;
        }
        LUCENT_INVARIANT(m_size > 0 && m_is_known.front());
    }

    // True when the pattern matches the start of code.
    constexpr auto matches(std::span<const std::byte> code) const -> bool {
        // The first byte is always known, and nearly every position fails on it.
        if (std::cmp_less(code.size(), m_size) || code.front() != std::byte{m_bytes.front()}) {
            return false;
        }
        const auto expected = std::views::zip(code, m_bytes, m_is_known) | std::views::take(m_size);
        return std::ranges::all_of(expected, [](const auto& each) {
            const auto& [actual, value, is_known] = each;
            return !is_known || actual == std::byte{value};
        });
    }

    constexpr auto size() const -> isize {
        return m_size;
    }

private:
    static consteval auto nibble(char digit) noexcept -> u32 {
        if (digit >= '0' && digit <= '9') {
            return static_cast<u32>(digit - '0');
        }
        if (digit >= 'A' && digit <= 'F') {
            return static_cast<u32>(digit - 'A' + 10);
        }
        LUCENT_INVARIANT(digit >= 'a' && digit <= 'f');
        return static_cast<u32>(digit - 'a' + 10);
    }

    std::array<u8, max_size> m_bytes{};
    std::array<bool, max_size> m_is_known{};
    isize m_size = 0;
};

// Where the code sections match the pattern, in address order.
auto pattern_rvas(const module_file& module, const byte_pattern& pattern) -> std::vector<u32>;

}
