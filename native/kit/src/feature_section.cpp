#include <lucent/kit/feature_section.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include <lucent/kit/feature.hpp>

namespace lucent::kit {
namespace {

// The section's bounds: zero, so a walk over the section skips them as it skips gaps.
__declspec(allocate(".lfeat$a")) constinit const u64 section_begin = 0;
__declspec(allocate(".lfeat$z")) constinit const u64 section_end = 0;

constexpr error malformed{.code = error_code::malformed};

constexpr usize slot_size = sizeof(u64);

auto u64_at(std::span<const std::byte> bytes) -> u64 {
    std::array<std::byte, slot_size> stored{};
    std::ranges::copy(bytes.first(slot_size), stored.begin());
    return std::bit_cast<u64>(stored);
}

// The tag up to its padding; nothing unless the padding is all NUL and the rest a feature tag.
auto tag_of(const std::array<char, max_feature_tag_size>& padded) -> result<std::string> {
    const auto end = std::ranges::find(padded, '\0');
    const std::string_view text{padded.begin(), end};
    const bool is_padded =
        std::ranges::all_of(end, padded.end(), [](char each) { return each == '\0'; });
    if (!is_padded || !feature_tag::is_feature_tag(text)) {
        return std::unexpected(malformed);
    }
    return std::string{text};
}

}

auto declared_features(std::span<const std::byte> section)
    -> result<std::vector<declared_feature>> {
    std::vector<declared_feature> declared;
    std::span<const std::byte> rest = section;
    while (rest.size() >= slot_size) {
        if (u64_at(rest) == 0) {
            rest = rest.subspan(slot_size);
            continue;
        }
        if (rest.size() < sizeof(feature_record)) {
            return std::unexpected(malformed);
        }
        std::array<std::byte, sizeof(feature_record)> stored{};
        std::ranges::copy(rest.first(sizeof(feature_record)), stored.begin());
        const auto record = std::bit_cast<feature_record>(stored);
        declared.push_back(
            declared_feature{.key = record.key, .tag = LUCENT_TRY(tag_of(record.tag))}
        );
        rest = rest.subspan(sizeof(feature_record));
    }
    return declared;
}

auto linked_feature_section() -> std::span<const std::byte> {
    // build: lld-link 23.1.5, grouped sections `.lfeat$a/$m/$z` merged in name order, as `.lcap`
    // found: tests/feature_section_test.cpp (the records of the features the test wires)
    // breaks: features missing from the walk, or bytes outside the section read as one
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
