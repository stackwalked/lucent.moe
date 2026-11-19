#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <span>
#include <string_view>
#include <type_traits>
#include <vector>

#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// Every fact kind: foreign memory is reached through globals, fields and values, game code through
// methods and slots, and a class is told by its vtable.
template <typename T>
inline constexpr bool is_fact = is_method_fact<T>
                                || is_global_fact<T>
                                || is_vtable_fact<T>
                                || is_slot_fact<T>
                                || is_field_fact<T>
                                || is_value_fact<T>;

// NOLINTBEGIN(readability-redundant-parentheses): instantiated, a reference template argument reads as `(fact)`.

// Whether every parameter names a fact object. A requires clause rather than `const C auto&`:
// Clang doesn't support a constrained placeholder on a reference template parameter yet.
template <const auto&... Facts>
inline constexpr bool are_facts = (is_fact<std::remove_cvref_t<decltype(Facts)>> && ...);

// Facts a feature can require together, named by the fact objects themselves. A type, never data:
// access built on it knows at compile time which facts it may reach.
template <const auto&... Facts>
    requires are_facts<Facts...>
struct capability {};

template <typename T>
inline constexpr bool is_capability = false;

template <const auto&... Facts>
inline constexpr bool is_capability<capability<Facts...>> = true;

template <typename T>
concept capability_like = is_capability<T>;

// Whether Fact is one of Capability's facts: the same object, not merely the same kind.
template <const auto& Fact, typename Capability>
inline constexpr bool is_part_of = false;

template <const auto& Fact, const auto&... Facts>
inline constexpr bool is_part_of<Fact, capability<Facts...>> =
    ((static_cast<const void*>(&Fact) == static_cast<const void*>(&Facts)) || ...);

// Available when every one of its facts resolved.
template <const auto&... Facts>
auto is_available(capability<Facts...> /*required*/) -> bool {
    return ((status_of(Facts.record()) == fact_status::resolved) && ...);
}

enum class capability_level : u8 {
    // Unavailable, it makes the features that need it unavailable, and nothing else.
    optional = 0,
    // Unavailable, it refuses the start; the server refuses a session that leaves it uncovered.
    core = 1,
};

// A capability's key: the identifier hash of its name under this build's capability subkey, its own
// purpose so a capability's key never equals a fact's. The name exists only at compile time.
consteval auto capability_key(std::string_view name) noexcept -> u64 {
    return identifier_hash(build::capability_subkey, name);
}

// What a capability's record in the capability section starts with; its members' fact keys follow
// it. No pointers: tools read records from the module file, where nothing is relocated.
struct capability_header {
    // 0 never names a capability: the linker may leave zeroed gaps between contributions.
    u64 key = 0;
    capability_level level = capability_level::optional;
    std::array<u8, 3> reserved{};
    u32 member_count = 0;
};

static_assert(sizeof(capability_header) == 16, "the file layout tools read");
static_assert(alignof(capability_header) == 8, "records start on 8-byte boundaries");
static_assert(offsetof(capability_header, level) == 8, "the file layout tools read");
static_assert(offsetof(capability_header, member_count) == 12, "the file layout tools read");

template <capability_like Capability>
class capability_record;

// A capability type's name and level, declared once beside it with LUCENT_CAPABILITY so the release
// manifest can say which capabilities exist, which are core, and what each needs. The facts come
// from the type, so they are listed once.
template <const auto&... Facts>
class capability_record<capability<Facts...>> final {
    static_assert(sizeof...(Facts) > 0, "a capability needs at least one fact");

public:
    consteval capability_record(std::string_view name, capability_level level) noexcept
        : m_header{
              .key = capability_key(name),
              .level = level,
              .reserved = {},
              .member_count = static_cast<u32>(sizeof...(Facts)),
          }
        , m_member_keys{Facts.record().key...} {
        static_assert(std::is_standard_layout_v<capability_record>, "the file layout tools read");
        static_assert(
            offsetof(capability_record, m_member_keys) == sizeof(capability_header), "keys follow"
        );
        static_assert(
            sizeof(capability_record) == sizeof(capability_header) + (8 * sizeof...(Facts)),
            "no padding"
        );
        std::array<u64, sizeof...(Facts)> sorted = m_member_keys;
        std::ranges::sort(sorted);
        // The same fact named twice is a typo in the declaration.
        LUCENT_INVARIANT(std::ranges::adjacent_find(sorted) == sorted.end());
    }

private:
    capability_header m_header;
    std::array<u64, sizeof...(Facts)> m_member_keys;
};

// NOLINTEND(readability-redundant-parentheses)

// A capability as its section record states it.
struct declared_capability {
    u64 key = 0;
    capability_level level = capability_level::optional;
    // In declaration order.
    std::vector<u64> members;

    auto operator==(const declared_capability&) const -> bool = default;
};

// The capabilities in a capability section's bytes, as the module file or the loaded image holds
// them, skipping zeroed gaps and kit's markers. Malformed when a record is cut short, has no
// members, a member key of 0, or a level this build doesn't know.
auto declared_capabilities(std::span<const std::byte> section)
    -> result<std::vector<declared_capability>>;

// The bytes of this image's own capability section, between kit's markers.
auto linked_capability_section() -> std::span<const std::byte>;

}

// The capability section, laid out like the fact section: `.lcap$a` and `.lcap$z` hold kit's
// markers, every record sits in `.lcap$m`, and lld-link merges them into one `.lcap` section.
#pragma section(".lcap$a", read)
#pragma section(".lcap$m", read)
#pragma section(".lcap$z", read)

// Declares a capability's record at namespace scope beside the capability type: one object per
// record in the whole image, placed in the capability section, constant-initialized with its key,
// level and members.
#define LUCENT_CAPABILITY __declspec(allocate(".lcap$m")) inline constinit const
