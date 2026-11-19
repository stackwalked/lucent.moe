// Compiled only by the test that expects it to fail (kit's CMakeLists): a feature reaching past its
// views to read foreign memory through a capability itself.

#include <lucent/foreign/memory_source.hpp>
#include <lucent/kit/context.hpp>
#include <lucent/kit/read_access.hpp>

#include "feature_fixtures.hpp"

namespace lucent::kit {
namespace {

[[maybe_unused]] auto peek(const context<fixtures::tracker>& /*parts*/) -> i32 {
    const read_access<fixtures::radar> game{foreign::memory_source::this_process()};
    return game.value<fixtures::radar_range>();
}

}
}
