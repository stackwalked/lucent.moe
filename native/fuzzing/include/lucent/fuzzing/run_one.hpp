#pragma once

#include <cstddef>
#include <span>

namespace lucent::fuzzing {

// One libFuzzer input. Each fuzz target defines this once; libFuzzer's own entry points live in
// fuzzing/src/entry.cpp. The bytes are hostile and the function returns normally on any of them:
// a sanitizer report, a crash or a broken invariant is the finding.
auto run_one(std::span<const std::byte> input) -> void;

}
