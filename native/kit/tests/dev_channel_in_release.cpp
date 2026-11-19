// Compiled only by the test that expects it to fail (kit's CMakeLists): a release build's use of
// the dev channel.

#include <lucent/kit/dev_channel.hpp>

namespace lucent::kit {
namespace {

[[maybe_unused]] auto announce() -> void {
    dev::send_text("a release build must not carry this");
}

}
}
