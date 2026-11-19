#pragma once

#include <memory>

#include <lucent/kit/lifecycle.hpp>

namespace lucent::cs2 {

// The cs2 module's attach, run by kit's lifecycle thread.
auto attach() -> result<std::unique_ptr<kit::attachment>>;

}
