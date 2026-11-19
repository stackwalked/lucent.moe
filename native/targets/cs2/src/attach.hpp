#pragma once

#include <memory>

#include <lucent/kit/domain_token.hpp>
#include <lucent/kit/lifecycle.hpp>
#include <lucent/kit/worker_set.hpp>

namespace lucent::cs2 {

// The cs2 module's attach, run by kit's lifecycle thread.
auto attach(kit::worker_set& workers, const kit::domain_token& opens)
    -> result<std::unique_ptr<kit::attachment>>;

}
