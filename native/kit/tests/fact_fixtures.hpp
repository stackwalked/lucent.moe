#pragma once

#include <lucent/kit/fact.hpp>

// Facts declared in a header that two translation units include: each must fold to one object.

namespace lucent::kit::fixtures {

LUCENT_FACT fact_record shared_value{
    .key = fact_key(dev_fact_seed, "shared_value"),
    .kind = fact_kind::value,
    .module = 1,
    .width = 4,
    .reserved = 0,
    .value = 0,
};

LUCENT_FACT fact_record shared_method{
    .key = fact_key(dev_fact_seed, "shared_method"),
    .kind = fact_kind::method,
    .module = 1,
    .width = 0,
    .reserved = 0,
    .value = 0,
};

// Defined in the other translation unit.
auto other_unit_shared_value() -> const fact_record*;
auto other_unit_own_fact() -> const fact_record*;

}
