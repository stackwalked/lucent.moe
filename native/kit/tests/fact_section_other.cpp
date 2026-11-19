#include <lucent/kit/capability.hpp>
#include <lucent/kit/fact.hpp>

#include "fact_fixtures.hpp"

// The second translation unit: it includes the shared facts and capability, and declares a fact and
// a capability of its own.

namespace lucent::kit::fixtures {
namespace {

struct other_owner {
    u64 first;
};

LUCENT_FACT fact::field<other_owner, u64> other_unit_fact{"other_unit_fact", 2};
using other_unit = capability<other_unit_fact, shared_value>;
LUCENT_CAPABILITY capability_record<other_unit> other_unit_capability [[gnu::used]]{
    "other_unit_capability",
    capability_level::optional,
};

}

auto other_unit_shared_value() -> const fact_record* {
    return &shared_value.record();
}

auto other_unit_own_fact() -> const fact_record* {
    return &other_unit_fact.record();
}

auto other_unit_shared_capability() -> const capability_record<shared>* {
    return &shared_capability;
}

}
