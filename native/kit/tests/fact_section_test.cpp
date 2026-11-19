#include <algorithm>
#include <span>
#include <string>

#include <catch2/catch_test_macros.hpp>

#include <lucent/kit/fact.hpp>

#include "fact_fixtures.hpp"

namespace lucent::kit {
namespace {

LUCENT_FACT fact::global<u64> this_unit_fact{"this_unit_fact", 3};

auto count_of(u64 key) -> usize {
    const std::span<const fact_record> section = linked_fact_records();
    return static_cast<usize>(std::ranges::count(section, key, &fact_record::key));
}

auto lies_in_section(const fact_record* record) -> bool {
    const std::span<const fact_record> section = linked_fact_records();
    return std::ranges::any_of(section, [&](const fact_record& linked) {
        return &linked == record;
    });
}

TEST_CASE("every fact of the image is in the section exactly once, a shared one folded to one") {
    CHECK(count_of(fixtures::shared_value.record().key) == 1);
    CHECK(count_of(fixtures::shared_method.record().key) == 1);
    CHECK(count_of(this_unit_fact.record().key) == 1);
    CHECK(count_of(fixtures::other_unit_own_fact()->key) == 1);
}

TEST_CASE("a shared fact is one object, wherever it's named, and it lives in the section") {
    CHECK(fixtures::other_unit_shared_value() == &fixtures::shared_value.record());
    CHECK(lies_in_section(&fixtures::shared_value.record()));
    CHECK(lies_in_section(&this_unit_fact.record()));
    CHECK(lies_in_section(fixtures::other_unit_own_fact()));
}

// Python's hashlib under the dev seed's fact subkey (core's identifier_hash_test says how), so the
// module's keys follow seed, subkey and name end to end. Release keys come from another subkey.
static_assert(
    LUCENT_KIT_DEV_BUILD == 0 || this_unit_fact.record().key == 0x31c1'fc0b'f111'a820,
    "a dev build's fact key is the keyed hash of its name under the dev fact subkey"
);

TEST_CASE("a fact's key in the section is the key the tools derive from its name at run time") {
    const std::string name{"this_unit_fact"};

    CHECK(fact_key_of(name) == this_unit_fact.record().key);
}

TEST_CASE("a write through the section is what the fact's owner reads") {
    for (const fact_record& record : linked_fact_records()) {
        if (record.key == this_unit_fact.record().key) {
            record.value = 0x1234;
        }
    }

    CHECK(this_unit_fact.record().value == 0x1234);
}

}
}
