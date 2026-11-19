#pragma once

#include <bit>
#include <concepts>
#include <type_traits>
#include <utility>

namespace lucent {

// An enum class whose enumerators are bits: its underlying type is unsigned, so every bit is a
// value and none is a sign.
template <typename T>
concept flaggable = std::is_scoped_enum_v<T> && std::unsigned_integral<std::underlying_type_t<T>>;

// A set of an enum class's bit values. Every value added or asked about must be a single bit.
template <flaggable E>
class flags {
public:
    constexpr explicit flags(std::same_as<E> auto... values) {
        (add(values), ...);
    }

    constexpr auto has(E value) const -> bool {
        return (m_bits & bit_of(value)) != bits_type{};
    }

    constexpr auto has_all(flags other) const -> bool {
        return (m_bits & other.m_bits) == other.m_bits;
    }

    constexpr auto has_any(flags other) const -> bool {
        return (m_bits & other.m_bits) != bits_type{};
    }

    constexpr auto is_empty() const -> bool {
        return m_bits == bits_type{};
    }

    friend constexpr auto operator|(flags left, flags right) -> flags {
        return from_bits(left.m_bits | right.m_bits);
    }

    friend constexpr auto operator|(flags left, E right) -> flags {
        left.add(right);
        return left;
    }

    friend constexpr auto operator==(flags left, flags right) -> bool = default;

private:
    using bits_type = std::underlying_type_t<E>;

    bits_type m_bits{};

    static constexpr auto bit_of(E value) -> bits_type {
        const bits_type bit = std::to_underlying(value);
        LUCENT_INVARIANT(std::has_single_bit(bit));
        return bit;
    }

    // Unsigned types narrower than int promote to it under |, so a union is cast back to the set's
    // width. No bit is lost: every operand fits in bits_type.
    static constexpr auto narrowed(std::integral auto bits) -> bits_type {
        return static_cast<bits_type>(bits);
    }

    constexpr auto add(E value) -> void {
        m_bits = narrowed(m_bits | bit_of(value));
    }

    static constexpr auto from_bits(std::integral auto bits) -> flags {
        flags set;
        set.m_bits = narrowed(bits);
        return set;
    }
};

template <flaggable E, std::same_as<E>... Rest>
flags(E, Rest...) -> flags<E>;

}
