#include <lucent/kit/fact.hpp>

#include "fact_fixtures.hpp"

// The second translation unit: it includes the shared facts and declares one of its own.

namespace lucent::kit::fixtures {
namespace {

LUCENT_FACT fact_record other_unit_fact{
    .key = fact_key(dev_fact_seed, "other_unit_fact"),
    .kind = fact_kind::field,
    .module = 2,
    .width = 8,
    .reserved = 0,
    .value = 0,
};

}

auto other_unit_shared_value() -> const fact_record* {
    return &shared_value;
}

auto other_unit_own_fact() -> const fact_record* {
    return &other_unit_fact;
}

}
