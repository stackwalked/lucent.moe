#pragma once

#include <vector>

#include <lucent/finder/target.hpp>

namespace lucent::facts {

// Every target this generator links, in the order --target lists them.
auto linked_targets() -> std::vector<finder::target>;

}
