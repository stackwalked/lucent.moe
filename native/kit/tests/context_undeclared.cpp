// Compiled only by the test that expects it to fail (kit's CMakeLists): a feature using a part it
// never declared.

#include <lucent/kit/context.hpp>

#include "feature_fixtures.hpp"

namespace lucent::kit {
namespace {

[[maybe_unused]] auto peek(const context<fixtures::tracker>& parts) -> i32 {
    return parts.view<fixtures::clock_view>().rate;
}

}
}
