#pragma once

#include <span>
#include <string_view>

namespace lucent::kit {

enum class fact_kind : u8 { method, global, vtable, slot, field, value };

// One fact as the fact section holds it. Every typed fact is exactly one of these, so the section
// is an array of them, written at resolve and read through its owner afterwards.
struct fact_record {
    // 0 never names a fact: the linker may leave zeroed gaps between contributions.
    u64 key = 0;
    fact_kind kind = fact_kind::value;
    // An index the target assigns to the game modules it knows.
    u8 module = 0;
    // The width of a field's or value's type, in bytes; 0 for the address and slot kinds.
    u16 width = 0;
    u32 reserved = 0;
    // 0 until resolved. Mutable so a fact object can be const: the resolve stage is its only
    // writer, at points where nothing reads it.
    mutable u64 value = 0;
};

static_assert(sizeof(fact_record) == 24, "fact records tile the section with no padding");
static_assert(alignof(fact_record) == 8, "fact records tile the section with no padding");

// Dev builds hash keys with this seed; release builds will take theirs from the generated build
// header, so a fact's key differs per release.
inline constexpr u64 dev_fact_seed = 0x6c75'6365'6e74'0001;

// FNV-1a over the seed's bytes, then the name's. The name exists only at compile time. noexcept for
// the constinit fact objects it initializes, which may not have a throwing initializer.
consteval auto fact_key(u64 seed, std::string_view name) noexcept -> u64 {
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

// Every fact the linked image holds, gaps skipped by the caller (key 0).
auto linked_fact_records() -> std::span<const fact_record>;

}

// The fact section: `.lfact$a` and `.lfact$z` hold kit's begin and end markers, every fact sits in
// `.lfact$m` between them, and lld-link merges the three into one `.lfact` section in name order.
#pragma section(".lfact$a", read, write)
#pragma section(".lfact$m", read, write)
#pragma section(".lfact$z", read, write)

// Declares a fact at namespace scope: one object per fact in the whole image (an inline variable
// folds to one copy), placed in the fact section, constant-initialized with its key. The object is
// const; only its resolved value is mutable, written at resolve.
#define LUCENT_FACT __declspec(allocate(".lfact$m")) inline constinit const
