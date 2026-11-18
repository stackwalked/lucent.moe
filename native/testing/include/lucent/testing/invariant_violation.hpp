#pragma once

#include <source_location>

namespace lucent::testing {

// What the test host's invariant handler throws, so a test can assert that a violation happened.
struct invariant_violation {
    std::source_location where;
};

}
