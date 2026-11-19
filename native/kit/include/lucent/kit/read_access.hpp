#pragma once

#include <concepts>
#include <type_traits>

#include <lucent/foreign/foreign_ptr.hpp>
#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/capability.hpp>
#include <lucent/kit/domain_token.hpp>
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

// The class a vtable or slot fact belongs to.
template <const auto& Fact>
using class_of = fact_type<Fact>::class_type;

namespace detail {

// A vtable's entries are code pointers, 8 bytes each on a 64-bit target.
inline constexpr u64 vtable_entry_size = 8;

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

template <const auto& Slot>
auto entry_ptr(u64 vtable) -> foreign::foreign_ptr<u64> {
    return {.address = vtable + (static_cast<u64>(Slot.index()) * vtable_entry_size)};
}

}

// What a domain builder reads foreign memory with: one capability's facts, through one memory
// source. Reaching for a fact the capability doesn't hold fails to compile, so a builder's
// requirements are the capability it names; opening one takes a domain token, which features never
// get.
template <capability_like Capability>
class read_access final {
public:
    // Only for an available capability: a builder runs only once its capability resolved.
    read_access(const domain_token& /*opened_by*/, foreign::memory_source source)
        : m_source{source} {
        LUCENT_INVARIANT(is_available(Capability{}));
    }

    explicit read_access(foreign::memory_source source) = delete (
        "features get views and stage tokens; a domain opens access with its domain_token"
    );

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
        LUCENT_INVARIANT(index >= 0 && Stride.get() > 0);
        if (foreign::is_null(first)) {
            return {};
        }
        const auto stride = static_cast<u64>(Stride.get());
        return {.address = first.address + (static_cast<u64>(index) * stride)};
    }

    // Whether the object is exactly the vtable's class: its vtable pointer is the fact's. Is-a over
    // several classes is a declared set of these, never a walk of the target's hierarchy.
    template <const auto& Vtable, foreign::addressable T>
        requires(is_vtable_fact<fact_type<Vtable>> && is_part_of<Vtable, Capability>)
    auto is_instance(foreign::foreign_ptr<T> object) const -> result<bool> {
        const u64 vtable = LUCENT_TRY(
            foreign::read(m_source, foreign::foreign_ptr<u64>{.address = object.address})
        );
        return vtable == Vtable.address();
    }

    // The code the object's own vtable holds at the slot, read through the object's vtable pointer.
    template <const auto& Slot>
        requires(is_slot_fact<fact_type<Slot>> && is_part_of<Slot, Capability>)
    auto slot_target(foreign::foreign_ptr<class_of<Slot>> object) const -> result<uptr> {
        const u64 vtable = LUCENT_TRY(
            foreign::read(m_source, foreign::foreign_ptr<u64>{.address = object.address})
        );
        return foreign::read(m_source, detail::entry_ptr<Slot>(vtable));
    }

    // The code a vtable fact holds at a slot fact of the same class.
    template <const auto& Vtable, const auto& Slot>
        requires(
            is_vtable_fact<fact_type<Vtable>>
            && is_slot_fact<fact_type<Slot>>
            && std::same_as<class_of<Vtable>, class_of<Slot>>
            && is_part_of<Vtable, Capability>
            && is_part_of<Slot, Capability>
        )
    auto vtable_entry() const -> result<uptr> {
        return foreign::read(m_source, detail::entry_ptr<Slot>(Vtable.address()));
    }

private:
    foreign::memory_source m_source;
};

// NOLINTEND(readability-redundant-parentheses)

}
