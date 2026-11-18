#pragma once

#include <lucent/kit/fact.hpp>

// Facts declared in a header that two translation units include: each must fold to one object.

namespace lucent::kit::fixtures {

LUCENT_FACT fact::value<i32> shared_value{"shared_value", 1, {.min = 0, .max = 100}};
LUCENT_FACT fact::method<void()> shared_method{"shared_method", 1};

// Defined in the other translation unit.
auto other_unit_shared_value() -> const fact_record*;
auto other_unit_own_fact() -> const fact_record*;

}
