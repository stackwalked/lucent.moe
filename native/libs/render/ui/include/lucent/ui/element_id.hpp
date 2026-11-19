#pragma once

#include <string_view>
#include <utility>

#include <lucent/core/fixed_string.hpp>

namespace lucent::ui {

// An element's identity across frames: its parent's id mixed with its key among its siblings.
enum class element_id : u64 {};

// What tells an element from its siblings: a literal hashed at compile time, a setting's path, or a
// list item's index.
enum class local_key : u64 {};

namespace detail {

// FNV-1a, 64-bit: stable across builds and runs, so an id means the same element every frame.
inline constexpr u64 fnv_offset = 14'695'981'039'346'656'037U;
inline constexpr u64 fnv_prime = 1'099'511'628'211U;

constexpr auto hashed(std::string_view text, u64 seed) -> u64 {
    u64 hash = seed;
    for (const char unit : text) {
        hash = (hash ^ u64{static_cast<u8>(unit)}) * fnv_prime;
    }
    return hash;
}

// splitmix64's finalizer: every input bit reaches every output bit, so ids of neighbouring keys
// under one parent share no structure.
constexpr auto mixed(u64 value) -> u64 {
    value = (value ^ (value >> 30U)) * 0xbf58'476d'1ce4'e5b9U;
    value = (value ^ (value >> 27U)) * 0x94d0'49bb'1331'11ebU;
    return value ^ (value >> 31U);
}

// Index keys and the keys the context gives unkeyed elements start from different seeds, so a list
// item never takes the id of an anonymous sibling.
inline constexpr u64 index_seed = 0x6c69'7374'2d69'6478U;
inline constexpr u64 anonymous_seed = 0x616e'6f6e'796d'6f75U;

}

template <fixed_string Name>
consteval auto key() -> local_key {
    return local_key{detail::hashed(Name.as_view(), detail::fnv_offset)};
}

constexpr auto key_from_text(std::string_view text) -> local_key {
    return local_key{detail::hashed(text, detail::fnv_offset)};
}

constexpr auto key_from_index(isize index) -> local_key {
    return local_key{detail::mixed(detail::index_seed ^ static_cast<u64>(index))};
}

constexpr auto child_id(element_id parent, local_key key) -> element_id {
    return element_id{
        detail::mixed((std::to_underlying(parent) * detail::fnv_prime) ^ std::to_underlying(key)),
    };
}

// A root's id: its key under no parent.
constexpr auto root_id(local_key key) -> element_id {
    return child_id(element_id{}, key);
}

}
