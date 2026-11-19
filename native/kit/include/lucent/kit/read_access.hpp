#pragma once

#include <type_traits>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

namespace lucent::kit {
namespace detail {

template <typename T>
struct foreign_of_type {
    using type = T;
};

template <typename T>
struct foreign_of_type<T*> {
    using type = foreign::foreign_ptr<T>;
};

}

namespace detail {

// A precondition of access built on a capability, checked outside the template: a failed
// invariant records the function it is in, and a function templated on a capability is named by
// its facts' names, which a release image must not hold (facts check). The recorded location is
// require_access's.
struct access_precondition {
    bool is_met = false;
};

inline auto require_access(access_precondition checked) -> void {
    LUCENT_INVARIANT(checked.is_met);
}

}

// A T the target holds, as held here: a pointer as a foreign_ptr, anything else as itself. Fact
// declarations keep the target's own types (`global<game_entity_system*>`).
template <typename T>
using foreign_of = detail::foreign_of_type<T>::type;

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.

template <const auto& Fact>
using fact_type = std::remove_cvref_t<decltype(Fact)>;

// What a global's or field's storage holds, as held here.
template <const auto& Fact>
using held_type = foreign_of<typename fact_type<Fact>::value_type>;

template <const auto& Field>
using owner_type = fact_type<Field>::owner_type;

namespace detail {

template <const auto& Global>
auto global_ptr() -> foreign::foreign_ptr<held_type<Global>> {
    return {.address = Global.address()};
}

// A null owner gives a null field, which then fails to read.
template <const auto& Field>
auto field_ptr(foreign::foreign_ptr<owner_type<Field>> owner)
    -> foreign::foreign_ptr<held_type<Field>> {
    if (foreign::is_null(owner)) {
        return {};
    }
    return {.address = owner.address + static_cast<u64>(Field.offset())};
}

}

// What a domain builder reads foreign memory with: one capability's facts, through one memory
// source. Reaching for a fact the capability doesn't hold fails to compile, so a builder's
// requirements are the capability it names.
template <capability_like Capability>
class read_access final {
public:
    // Only for an available capability: a builder runs only once its capability resolved.
    explicit read_access(foreign::memory_source source)
        : m_source{source} {
        detail::require_access({.is_met = is_available(Capability{})});
    }

    template <const auto& Global>
        requires(is_global_fact<fact_type<Global>> && is_part_of<Global, Capability>)
    auto read() const -> result<held_type<Global>> {
        return foreign::read(m_source, detail::global_ptr<Global>());
    }

    template <const auto& Field>
        requires(is_field_fact<fact_type<Field>> && is_part_of<Field, Capability>)
    auto read(foreign::foreign_ptr<owner_type<Field>> owner) const -> result<held_type<Field>> {
        return foreign::read(m_source, detail::field_ptr<Field>(owner));
    }

    template <const auto& Global>
        requires(is_global_fact<fact_type<Global>> && is_part_of<Global, Capability>)
    auto global_ptr() const -> foreign::foreign_ptr<held_type<Global>> {
        return detail::global_ptr<Global>();
    }

    template <const auto& Field>
        requires(is_field_fact<fact_type<Field>> && is_part_of<Field, Capability>)
    auto field_ptr(foreign::foreign_ptr<owner_type<Field>> owner) const
        -> foreign::foreign_ptr<held_type<Field>> {
        return detail::field_ptr<Field>(owner);
    }

    template <const auto& Value>
        requires(is_value_fact<fact_type<Value>> && is_part_of<Value, Capability>)
    auto value() const -> fact_type<Value>::value_type {
        return Value.get();
    }

    // The index-th element of a foreign array whose stride is a value fact. A null array gives a
    // null element.
    template <const auto& Stride, foreign::addressable T>
        requires(is_value_fact<fact_type<Stride>> && is_part_of<Stride, Capability>)
    auto element(foreign::foreign_ptr<T> first, isize index) const -> foreign::foreign_ptr<T> {
        detail::require_access({.is_met = index >= 0 && Stride.get() > 0});
        if (foreign::is_null(first)) {
            return {};
        }
        const auto stride = static_cast<u64>(Stride.get());
        return {.address = first.address + (static_cast<u64>(index) * stride)};
    }

private:
    foreign::memory_source m_source;
};

// NOLINTEND(readability-redundant-parentheses)

}
