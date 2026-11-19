#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>
#include <utility>
#include <vector>

#include <lucent/kit/capability.hpp>

namespace lucent::kit {
namespace {

// The section's bounds: zero, so a walk over the section skips them as it skips gaps.
__declspec(allocate(".lcap$a")) constinit const u64 section_begin = 0;
__declspec(allocate(".lcap$z")) constinit const u64 section_end = 0;

constexpr error malformed{.code = error_code::malformed};

constexpr usize slot_size = sizeof(u64);

auto u64_at(std::span<const std::byte> bytes) -> u64 {
    std::array<std::byte, slot_size> stored{};
    std::ranges::copy(bytes.first(slot_size), stored.begin());
    return std::bit_cast<u64>(stored);
}

auto level_of(u8 stored) -> result<capability_level> {
    switch (stored) {
    case std::to_underlying(capability_level::optional):
        return capability_level::optional;
    case std::to_underlying(capability_level::core):
        return capability_level::core;
    default:
        return std::unexpected(malformed);
    }
}

// One record at the start of `bytes`; `bytes` is left after its member keys.
auto read_record(std::span<const std::byte>& bytes) -> result<declared_capability> {
    if (bytes.size() < sizeof(capability_header)) {
        return std::unexpected(malformed);
    }
    std::array<std::byte, sizeof(capability_header)> stored{};
    std::ranges::copy(bytes.first(sizeof(capability_header)), stored.begin());
    const auto header = std::bit_cast<capability_header>(stored);
    bytes = bytes.subspan(sizeof(capability_header));

    declared_capability declared{
        .key = header.key,
        .level = LUCENT_TRY(level_of(std::to_underlying(header.level))),
        .members = {},
    };
    const usize count = header.member_count;
    if (count == 0 || count > bytes.size() / slot_size) {
        return std::unexpected(malformed);
    }
    declared.members.reserve(count);
    for (usize index = 0; index < count; ++index) {
        const u64 member = u64_at(bytes.subspan(index * slot_size));
        if (member == 0) {
            return std::unexpected(malformed);
        }
        declared.members.push_back(member);
    }
    bytes = bytes.subspan(slot_size * count);
    return declared;
}

}

auto declared_capabilities(std::span<const std::byte> section)
    -> result<std::vector<declared_capability>> {
    std::vector<declared_capability> declared;
    std::span<const std::byte> rest = section;
    while (rest.size() >= slot_size) {
        if (u64_at(rest) == 0) {
            rest = rest.subspan(slot_size);
            continue;
        }
        declared.push_back(LUCENT_TRY(read_record(rest)));
    }
    return declared;
}

auto linked_capability_section() -> std::span<const std::byte> {
    // build: lld-link 23.1.5, grouped sections `.lcap$a/$m/$z` merged in name order
    // found: tests/capability_test.cpp (two translation units, an inline capability folded)
    // breaks: capabilities missing from the walk, or bytes outside the section read as one
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage" // bounded by the linker's own markers
#pragma clang diagnostic ignored "-Wunsafe-buffer-usage-in-container" // as above
    // NOLINTBEGIN(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-type-reinterpret-cast): the section is bytes the linker laid out between the markers.
    const auto* const first = reinterpret_cast<const std::byte*>(&section_begin + 1);
    const auto* const last = reinterpret_cast<const std::byte*>(&section_end);
    return std::span<const std::byte>{first, last};
    // NOLINTEND(cppcoreguidelines-pro-bounds-pointer-arithmetic,cppcoreguidelines-pro-type-reinterpret-cast)
#pragma clang diagnostic pop
}

}
