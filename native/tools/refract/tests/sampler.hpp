#pragma once

#include <array>
#include <random>

#include <lucent/core/narrow.hpp>
#include <lucent/refract/machine.hpp>

namespace lucent::refract {

// A seeded stream of random choices for the differential tests. A copy would replay the same
// draws.
class sampler final {
public:
    explicit sampler(u64 seed)
        : m_rng{seed} {}

    sampler(const sampler&) = delete ("a copy would replay the same draws");
    auto operator=(const sampler&) -> sampler& = delete ("a copy would replay the same draws");
    sampler(sampler&&) = delete ("a moved-from stream would replay the same draws");
    auto operator=(sampler&&) -> sampler& = delete ("a moved-from stream would replay the draws");
    ~sampler() = default;

    auto below(u64 bound) -> u64 {
        return m_rng() % bound;
    }

    auto any() -> u64 {
        return m_rng();
    }

    // Uniform half the time, else a value at an edge of some width, where flags change.
    auto number() -> u64 {
        static constexpr std::array<u64, 15> edges{
            0,
            1,
            2,
            0x7f,
            0x80,
            0xff,
            0x7fff,
            0x8000,
            0xffff,
            0x7fff'ffff,
            0x8000'0000,
            0xffff'ffff,
            0x7fff'ffff'ffff'ffff,
            0x8000'0000'0000'0000,
            0xffff'ffff'ffff'ffff,
        };
        if (below(2) == 0) {
            return any();
        }
        return edges.at(below(edges.size()));
    }

    auto reg() -> gpr {
        return gpr{narrow<u8>(below(gpr_count))};
    }

private:
    std::mt19937_64 m_rng;
};

}
