#pragma once

#include <vector>

#include <lucent/finders/target.hpp>

namespace lucent::factgen {

// Every target this generator links, in the order --target lists them.
auto linked_targets() -> std::vector<finders::target>;

}
