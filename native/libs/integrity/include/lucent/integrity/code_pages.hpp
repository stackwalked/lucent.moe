#pragma once

#include <span>

#include <lucent/os/address_range.hpp>

namespace lucent::integrity {

// Whether every page of the ranges, in this process, is still committed, executable and not
// writable. A guard page counts against it: guard pages are how page-fault hooks trap execution.
auto is_code_sealed(std::span<const os::address_range> ranges) -> bool;

}
