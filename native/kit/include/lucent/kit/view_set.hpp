#pragma once

#include <algorithm>
#include <source_location>
#include <string_view>
#include <vector>

#include <lucent/kit/fact.hpp>
#include <lucent/kit/feature.hpp>

namespace lucent::kit {
namespace detail {

// A key per type, hashed from the name the compiler gives the function instantiated for it. The
// name exists only at compile time.
// build: clang 23.1.5, whose source_location::function_name() spells the template arguments
// found: static_asserts in tests/context_test.cpp tell two parts apart, nested templates included
// breaks: every part gets one key, and view_set::put refuses the second part a domain hands it
template <typename T>
consteval auto type_key() -> u64 {
    return fact_name_hash(0, std::source_location::current().function_name());
}

}

// The parts a domain built for this tick, borrowed until it has dispatched. A part a domain
// couldn't build (its capability unavailable, or this tick's read failed) is simply absent.
class view_set final {
public:
    template <backed Part>
    auto put(const Part& part) -> void {
        constexpr u64 key = detail::type_key<Part>();
        LUCENT_INVARIANT(!std::ranges::contains(m_parts, key, &entry::key));
        m_parts.push_back(entry{.key = key, .part = &part});
    }

    template <backed Part>
    auto find() const -> const Part* {
        constexpr u64 key = detail::type_key<Part>();
        const auto found = std::ranges::find(m_parts, key, &entry::key);
        return found == m_parts.end() ? nullptr : static_cast<const Part*>(found->part);
    }

private:
    struct entry {
        u64 key = 0;
        const void* part = nullptr;
    };

    std::vector<entry> m_parts;
};

}
