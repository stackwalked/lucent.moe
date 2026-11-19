#pragma once

#include <algorithm>
#include <array>
#include <span>
#include <vector>

#include <lucent/kit/fact.hpp>

namespace lucent::kit {

// A value for one fact, as a fact set delivers it: an address kind's RVA within its module, a
// slot's index, a field's offset, or a value.
struct fact_value {
    u64 key = 0;
    u64 value = 0;
};

struct image_section {
    u32 rva = 0;
    u32 size = 0;
    bool is_executable = false;
    bool is_writable = false;
};

// A game module as loaded in this process, with what the load checks measure against.
struct module_image {
    u8 index = 0;
    uptr base = 0;
    usize size = 0;
    std::vector<image_section> sections;
    // The headers' half of the module's build key (the name is the other).
    u32 time_date_stamp = 0;
    u32 size_of_image = 0;
};

// Reads the image's own headers where it's loaded. They're foreign memory, so the read is
// contained; a fault comes back as malformed.
auto image_at(u8 index, uptr base) -> result<module_image>;

struct resolve_report {
    u32 resolved = 0;
    u32 rejected = 0;
    // Facts no value arrived for.
    u32 unresolved = 0;
    // Values for facts this image doesn't link (another build, or a stripped feature).
    u32 unknown = 0;
};

// Writes each value into its fact after the kind's check against the loaded image:
// - method: in an executable section, and a function start wherever .pdata knows the function;
// - global: in a section that isn't executable, aligned for its type;
// - vtable: in read-only data, 8-aligned, its first entry pointing into an executable section;
// - slot: below its vtable's length (counted entry by entry) when that vtable is a fact;
// - field: aligned for its type, inside its owner's size when that size is a fact;
// - value: within its range.
// Every fact starts unresolved; one that fails is rejected and keeps no value. Two records with one
// key are our own bug.
auto resolve(
    std::span<const fact_record> records,
    std::span<const fact_value> values,
    std::span<const module_image> modules
) -> resolve_report;

// Facts a feature can require together. Available when every one of them resolved.
template <usize Count>
class capability final {
public:
    template <typename... Facts>
        requires(sizeof...(Facts) == Count)
    consteval explicit capability(const Facts&... facts) noexcept
        : m_facts{&facts.record()...} {}

    auto is_available() const -> bool {
        return std::ranges::all_of(m_facts, [](const fact_record* member) {
            return member->status == fact_status::resolved;
        });
    }

private:
    std::array<const fact_record*, Count> m_facts;
};

template <typename... Facts>
capability(const Facts&...) -> capability<sizeof...(Facts)>;

}
