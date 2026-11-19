#pragma once

#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::kit {

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.

// What a domain applies its intents with, once per tick: one capability's facts, through one
// memory source. Features never hold one; like read_access, a fact outside the capability fails to
// compile.
template <capability_like Capability>
class write_access final {
public:
    // Only for an available capability.
    explicit write_access(foreign::memory_source source)
        : m_source{source} {
        LUCENT_INVARIANT(is_available(Capability{}));
    }

    template <const auto& Global>
        requires(is_global_fact<fact_type<Global>> && is_part_of<Global, Capability>)
    auto write(held_type<Global> value) const -> result<void> {
        return foreign::write(m_source, detail::global_ptr<Global>(), value);
    }

    template <const auto& Field>
        requires(is_field_fact<fact_type<Field>> && is_part_of<Field, Capability>)
    auto write(foreign::foreign_ptr<owner_type<Field>> owner, held_type<Field> value) const
        -> result<void> {
        return foreign::write(m_source, detail::field_ptr<Field>(owner), value);
    }

private:
    foreign::memory_source m_source;
};

// NOLINTEND(readability-redundant-parentheses)

}
