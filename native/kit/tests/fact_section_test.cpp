#include <algorithm>
#include <span>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/fact.hpp>

#include "fact_fixtures.hpp"

namespace lucent::kit {
namespace {

LUCENT_FACT fact_record this_unit_fact{
    .key = fact_key(dev_fact_seed, "this_unit_fact"),
    .kind = fact_kind::global,
    .module = 3,
    .width = 0,
    .reserved = 0,
    .value = 0,
};

auto present_keys() -> std::vector<u64> {
    std::vector<u64> keys;
    for (const fact_record& record : linked_fact_records()) {
        if (record.key != 0) {
            keys.push_back(record.key);
        }
    }
    return keys;
}

auto lies_in_section(const fact_record* record) -> bool {
    const std::span<const fact_record> section = linked_fact_records();
    return std::ranges::any_of(section, [&](const fact_record& linked) {
        return &linked == record;
    });
}

TEST_CASE("every fact of the image is in the section exactly once, a shared one folded to one") {
    std::vector<u64> keys = present_keys();
    std::ranges::sort(keys);

    CHECK(std::ranges::adjacent_find(keys) == keys.end());
    CHECK(keys.size() == 4);
    CHECK(std::ranges::binary_search(keys, fixtures::shared_value.key));
    CHECK(std::ranges::binary_search(keys, fixtures::shared_method.key));
    CHECK(std::ranges::binary_search(keys, this_unit_fact.key));
    CHECK(std::ranges::binary_search(keys, fixtures::other_unit_own_fact()->key));
}

TEST_CASE("a shared fact is one object, wherever it's named, and it lives in the section") {
    CHECK(fixtures::other_unit_shared_value() == &fixtures::shared_value);
    CHECK(lies_in_section(&fixtures::shared_value));
    CHECK(lies_in_section(&this_unit_fact));
    CHECK(lies_in_section(fixtures::other_unit_own_fact()));
}

TEST_CASE("a write through the section is what the fact's owner reads") {
    for (const fact_record& record : linked_fact_records()) {
        if (record.key == this_unit_fact.key) {
            record.value = 0x1234;
        }
    }

    CHECK(this_unit_fact.value == 0x1234);
}

}
}
