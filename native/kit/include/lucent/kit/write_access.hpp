#pragma once

#include <bit>
#include <concepts>
#include <type_traits>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/kit/read_access.hpp>

namespace lucent::kit {
namespace detail {

// A value as the target's own code takes it: a foreign_ptr as the pointer it holds.
template <typename Native>
auto as_native(foreign_of<Native> value) -> Native {
    if constexpr (std::is_pointer_v<Native>) {
        return std::bit_cast<Native>(value.address);
    } else {
        return value;
    }
}

template <typename Signature>
struct method_call;

// A method fact's function called with the values a domain holds, its result handed back as held
// here.
template <typename R, typename... Args>
struct method_call<R(Args...)> {
    static auto invoke(uptr address, foreign_of<Args>... args) -> foreign_of<R> {
        const auto function = std::bit_cast<R (*)(Args...)>(address);
        if constexpr (std::is_void_v<R>) {
            function(as_native<Args>(args)...);
        } else if constexpr (std::is_pointer_v<R>) {
            return {.address = std::bit_cast<u64>(function(as_native<Args>(args)...))};
        } else {
            return function(as_native<Args>(args)...);
        }
    }
};

// NOLINTNEXTLINE(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.
template <const auto& Method>
using call_of = decltype(&method_call<typename fact_type<Method>::signature>::invoke);

}

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.

// What a domain applies its intents with, once per tick: one capability's facts, through one
// memory source. Features never hold one; like read_access, a fact outside the capability fails to
// compile, and opening one takes a domain token.
template <capability_like Capability>
class write_access final {
public:
    // Only for an available capability.
    write_access(const domain_token& /*opened_by*/, foreign::memory_source source)
        : m_source{source} {
        LUCENT_INVARIANT(is_available(Capability{}));
    }

    explicit write_access(foreign::memory_source source) = delete (
        "features get views and stage tokens; a domain opens access with its domain_token"
    );

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

    // Calls the game's own function, typed by its fact, on this thread and in this process
    // whatever the memory source: the game's code is what touches its memory, so a fault in it is
    // the caller's contain()'s. A pointer goes in and comes out as a foreign_ptr.
    template <const auto& Method, typename... Given>
        requires(
            is_method_fact<fact_type<Method>>
            && is_part_of<Method, Capability>
            && std::invocable<detail::call_of<Method>, uptr, Given...>
        )
    auto call(Given... given) const {
        return detail::method_call<typename fact_type<Method>::signature>::invoke(
            Method.address(), given...
        );
    }

private:
    foreign::memory_source m_source;
};

// NOLINTEND(readability-redundant-parentheses)

}
