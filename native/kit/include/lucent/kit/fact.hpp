#pragma once

#include <atomic>
#include <source_location>
#include <span>
#include <string_view>

#include <lucent/core/build/subkeys.hpp>
#include <lucent/core/identifier_hash.hpp>

namespace lucent::kit {

enum class fact_kind : u8 { method, global, vtable, slot, field, value };

enum class fact_status : u8 {
    // No value arrived for it.
    unresolved,
    // A value arrived and failed its kind's check.
    rejected,
    resolved,
};

// One fact as the fact section holds it. Every typed fact is exactly one of these, so the section
// is an array of them; resolve writes the mutable members, everything else is fixed at compile
// time.
struct fact_record {
    // 0 never names a fact: the linker may leave zeroed gaps between contributions.
    u64 key = 0;
    fact_kind kind = fact_kind::value;
    // An index the target assigns to the game modules it knows.
    u8 module = 0;
    // A field's or value's type: its width and required alignment, in bytes.
    u16 width = 0;
    u8 alignment = 0;
    mutable fact_status status = fact_status::unresolved;
    u16 reserved = 0;
    // What the kind's check measures against: a field's owner-size fact key, a slot's vtable fact
    // key (0 for neither), or a value's range (see value_range).
    u64 bound = 0;
    // A method's, global's or vtable's address; a slot's index; a field's offset; a value.
    mutable u64 value = 0;
};

static_assert(sizeof(fact_record) == 32, "fact records tile the section with no padding");
static_assert(alignof(fact_record) == 8, "fact records tile the section with no padding");

// FNV-1a over the seed's bytes, then the name's: the capability and game module name hashes, whose
// seeds are fixed and public. Fact keys don't use it: it is invertible, so a guessed name and its
// hash give back the seed.
constexpr auto fact_name_hash(u64 seed, std::string_view name) noexcept -> u64 {
    constexpr u64 offset_basis = 0xcbf2'9ce4'8422'2325;
    constexpr u64 prime = 0x0000'0100'0000'01b3;
    u64 hash = offset_basis;
    for (u32 shift = 0; shift < 64; shift += 8) {
        hash = (hash ^ ((seed >> shift) & 0xffU)) * prime;
    }
    for (const char letter : name) {
        hash = (hash ^ static_cast<u8>(letter)) * prime;
    }
    // 0 marks a gap in the section, never a fact.
    return hash == 0 ? 1 : hash;
}

// A fact's key: the identifier hash of its name under this build's fact subkey, so keys differ per
// release (dev's subkey is fixed and public) and a shipped key gives back neither the name nor the
// subkey. The one derivation of a fact key: tools that take fact names from a person or a finder
// (devkey, facts) call it at run time with the subkey of the build tree they were built in, which
// is the module's. Module code reaches it only through fact_key, so no name ships.
constexpr auto fact_key_of(std::string_view name) -> u64 {
    return identifier_hash(build::fact_subkey, name);
}

// A fact's key, at compile time; the name exists only there. noexcept for the constinit fact
// objects it initializes, which may not have a throwing initializer.
consteval auto fact_key(std::string_view name) noexcept -> u64 {
    return fact_key_of(name);
}

// The inclusive range a value fact must fall in; carried in its record's bound.
struct value_range {
    i32 min = 0;
    i32 max = 0;
};

consteval auto pack(value_range range) noexcept -> u64 {
    return static_cast<u64>(static_cast<u32>(range.min))
           | (static_cast<u64>(static_cast<u32>(range.max)) << 32U);
}

constexpr auto unpack_range(u64 bound) -> value_range {
    return value_range{
        .min = static_cast<i32>(static_cast<u32>(bound & 0xffff'ffffU)),
        .max = static_cast<i32>(static_cast<u32>(bound >> 32U)),
    };
}

// Every fact the linked image holds, gaps among them (key 0) included.
auto linked_fact_records() -> std::span<const fact_record>;

namespace detail {

// What a typed fact is made of; built at compile time.
struct fact_shape {
    fact_kind kind = fact_kind::value;
    u8 module = 0;
    u16 width = 0;
    u8 alignment = 0;
    u64 bound = 0;
};

consteval auto make_record(std::string_view name, fact_shape shape) noexcept -> fact_record {
    return fact_record{
        .key = fact_key(name),
        .kind = shape.kind,
        .module = shape.module,
        .width = shape.width,
        .alignment = shape.alignment,
        .status = fact_status::unresolved,
        .reserved = 0,
        .bound = shape.bound,
        .value = 0,
    };
}

}

// A fact's status as resolve last published it, from any thread. Acquire pairs with resolve's
// release store: a reader that sees resolved also sees the value written before it.
inline auto status_of(const fact_record& record) -> fact_status {
    return std::atomic_ref<fact_status>{record.status}.load(std::memory_order_acquire);
}

namespace detail {

// The one way any fact's value is read. Reading a fact that didn't resolve is our own bug: the
// feature reading it didn't require the capability that holds it.
inline auto read(const fact_record& record) -> u64 {
    LUCENT_INVARIANT(status_of(record) == fact_status::resolved);
    return record.value;
}

}

// The typed kinds. Each holds one fact_record and nothing else, so a typed fact in the section is
// a record. Foreign memory is reached through them by read_access and write_access; here they
// expose their resolved values.
namespace fact {

template <typename Signature>
class method;

// A function in a game module; the value is its address.
template <typename R, typename... Args>
class method<R(Args...)> final {
public:
    consteval method(std::string_view name, u8 module) noexcept
        : m_record{detail::make_record(name, {.kind = fact_kind::method, .module = module})} {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto address() const -> uptr {
        return detail::read(m_record);
    }

private:
    fact_record m_record;
};

// Data in a game module; the value is its address.
template <typename T>
class global final {
public:
    using value_type = T;

    consteval global(std::string_view name, u8 module) noexcept
        : m_record{
              detail::make_record(
                  name, {.kind = fact_kind::global, .module = module, .alignment = alignof(T)}
              ),
          } {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto address() const -> uptr {
        return detail::read(m_record);
    }

private:
    fact_record m_record;
};

// A class's complete-object vtable; the value is its address.
template <typename Class>
class vtable final {
public:
    consteval vtable(std::string_view name, u8 module) noexcept
        : m_record{detail::make_record(name, {.kind = fact_kind::vtable, .module = module})} {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto address() const -> uptr {
        return detail::read(m_record);
    }

private:
    fact_record m_record;
};

template <typename Signature>
class slot;

// A virtual method's index in its class's vtable. Bounded by that vtable's length when the vtable
// is itself a fact (named by `vtable_name`).
template <typename R, typename Class, typename... Args>
class slot<R(Class*, Args...)> final {
public:
    consteval slot(std::string_view name, u8 module) noexcept
        : m_record{detail::make_record(name, {.kind = fact_kind::slot, .module = module})} {}

    consteval slot(std::string_view name, u8 module, std::string_view vtable_name) noexcept
        : m_record{
              detail::make_record(
                  name,
                  {
                      .kind = fact_kind::slot,
                      .module = module,
                      .bound = fact_key(vtable_name),
                  }
              ),
          } {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto index() const -> isize {
        return static_cast<isize>(detail::read(m_record));
    }

private:
    fact_record m_record;
};

// A T at a byte offset inside a foreign Owner. Bounded by Owner's size when that size is itself a
// value fact (named by `owner_size_name`).
template <typename Owner, typename T>
class field final {
public:
    using owner_type = Owner;
    using value_type = T;

    consteval field(std::string_view name, u8 module) noexcept
        : m_record{
              detail::make_record(
                  name,
                  {
                      .kind = fact_kind::field,
                      .module = module,
                      .width = sizeof(T),
                      .alignment = alignof(T),
                  }
              ),
          } {}

    consteval field(std::string_view name, u8 module, std::string_view owner_size_name) noexcept
        : m_record{
              detail::make_record(
                  name,
                  {
                      .kind = fact_kind::field,
                      .module = module,
                      .width = sizeof(T),
                      .alignment = alignof(T),
                      .bound = fact_key(owner_size_name),
                  }
              ),
          } {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto offset() const -> isize {
        return static_cast<isize>(detail::read(m_record));
    }

private:
    fact_record m_record;
};

// A number (a stride, an index, an enum value) within a declared range.
template <typename T>
class value final {
public:
    using value_type = T;

    consteval value(std::string_view name, u8 module, value_range range) noexcept
        : m_record{
              detail::make_record(
                  name,
                  {
                      .kind = fact_kind::value,
                      .module = module,
                      .width = sizeof(T),
                      .bound = pack(range),
                  }
              ),
          } {}

    constexpr auto record() const -> const fact_record& {
        return m_record;
    }

    auto get() const -> T {
        return static_cast<T>(static_cast<i64>(detail::read(m_record)));
    }

private:
    fact_record m_record;
};

}

template <typename T>
inline constexpr bool is_global_fact = false;

template <typename T>
inline constexpr bool is_global_fact<fact::global<T>> = true;

template <typename T>
inline constexpr bool is_field_fact = false;

template <typename Owner, typename T>
inline constexpr bool is_field_fact<fact::field<Owner, T>> = true;

template <typename T>
inline constexpr bool is_value_fact = false;

template <typename T>
inline constexpr bool is_value_fact<fact::value<T>> = true;

}

// The fact section: `.lfact$a` and `.lfact$z` hold kit's begin and end markers, every fact sits in
// `.lfact$m` between them, and lld-link merges the three into one `.lfact` section in name order.
#pragma section(".lfact$a", read, write)
#pragma section(".lfact$m", read, write)
#pragma section(".lfact$z", read, write)

// Declares a fact at namespace scope: one object per fact in the whole image (an inline variable
// folds to one copy), placed in the fact section, constant-initialized with its key. The object is
// const; only its status and resolved value are mutable, written at resolve. constexpr rather
// than constinit so a capability's consteval constructor can read its members' keys; the mutable
// members stay out of constant evaluation and are never folded.
//
// `used`, for optimized builds (clang-cl 23.1.5, /O2, found by the release preset's kit tests):
// without it LLVM drops a fact referenced only for its compile-time key, so the section misses it,
// and marks an internal-linkage fact it sees no store to as constant, which lands it in a
// read-only `.lfact$m` that lld links as a second `.lfact` outside kit's markers, and folds its
// value reads to 0. `used` makes LLVM assume references it can't see: emitted and writable.
#define LUCENT_FACT [[gnu::used]] __declspec(allocate(".lfact$m")) inline constexpr
