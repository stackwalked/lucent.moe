#pragma once

#include <memory>

#include <lucent/kit/lifecycle.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2 {

// The cs2 module's attach, run by kit's lifecycle thread.
auto attach(kit::worker_set& workers) -> result<std::unique_ptr<kit::attachment>>;

}
