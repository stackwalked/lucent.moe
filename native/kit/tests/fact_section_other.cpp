#include <lucent/kit/fact.hpp>

#include "fact_fixtures.hpp"

// The second translation unit: it includes the shared facts and declares one of its own.

namespace lucent::kit::fixtures {
namespace {

struct other_owner {
    u64 first;
};

LUCENT_FACT fact::field<other_owner, u64> other_unit_fact{"other_unit_fact", 2};

}

auto other_unit_shared_value() -> const fact_record* {
    return &shared_value.record();
}

auto other_unit_own_fact() -> const fact_record* {
    return &other_unit_fact.record();
}

}
