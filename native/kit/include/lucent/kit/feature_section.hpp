#pragma once

#include <array>
#include <cstddef>
#include <span>
#include <string>
#include <utility>
#include <vector>

#include <lucent/kit/feature.hpp>

// The feature section, laid out like the capability section: `.lfeat$a` and `.lfeat$z` hold kit's
// markers, every record sits in `.lfeat$m`, and lld-link merges them into one `.lfeat` section.
// It lists every wired feature's keyed id and tag, so the release manifest can map an
// entitlement's tags to this release's ids.
#pragma section(".lfeat$a", read)
#pragma section(".lfeat$m", read)
#pragma section(".lfeat$z", read)

namespace lucent::kit {

// One feature's record in the feature section. No pointers: tools read records from the module
// file, where nothing is relocated.
struct feature_record {
    // 0 never names a feature: the linker may leave zeroed gaps between contributions.
    u64 key = 0;
    // NUL-padded.
    std::array<char, max_feature_tag_size> tag{};
};

static_assert(sizeof(feature_record) == 72, "the file layout tools read");
static_assert(alignof(feature_record) == 8, "records start on 8-byte boundaries");
static_assert(offsetof(feature_record, tag) == 8, "the file layout tools read");

// Made at compile time, so the record's static initialization can't throw.
template <feature_like F>
consteval auto record_for() noexcept -> feature_record {
    return feature_record{.key = std::to_underlying(F::id), .tag = F::tag.as_padded()};
}

// A wired feature's record: one per feature type in the whole image, placed when wiring::add
// names it, so every feature the target ships is listed and none it doesn't.
template <feature_like F>
[[gnu::used]]
__declspec(allocate(".lfeat$m")) inline constinit const feature_record feature_record_of =
    record_for<F>();

// A feature as its section record states it.
struct declared_feature {
    u64 key = 0;
    std::string tag;

    auto operator==(const declared_feature&) const -> bool = default;
};

// The features in a feature section's bytes, as the module file or the loaded image holds them,
// skipping zeroed gaps and kit's markers. Malformed when a record is cut short or its tag isn't a
// feature tag padded with NULs.
auto declared_features(std::span<const std::byte> section) -> result<std::vector<declared_feature>>;

// The bytes of this image's own feature section, between kit's markers.
auto linked_feature_section() -> std::span<const std::byte>;

}
