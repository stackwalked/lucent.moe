#pragma once

#include <string>

#include <lucent/wire/refusal.hpp>

namespace lucent::loader {

// For the console. The words for each refusal are the site's (web/src/copy/refusals.ts); the
// loader names the code, which the site explains.
auto describe(const error& failure) -> std::string;
auto describe(wire::refusal_code code) -> std::string;

}
