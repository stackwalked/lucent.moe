#pragma once

#include <lucent/core/fault.hpp>
#include <lucent/core/stdx/function_ref.hpp>

namespace lucent {

// Runs body and returns what stopped it as a fault: a raise() (LUCENT_ENSURE), or an access
// violation, page error or misaligned access. Every other exception passes through and crashes as
// it would have.
//
// A memory fault skips the destructors of every frame between it and this call (/EHsc), so body
// must not hold kit resources while it touches foreign memory.
auto contain(stdx::function_ref<void()> body) -> contained<void>;

}
