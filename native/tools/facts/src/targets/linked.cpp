#include "targets/linked.hpp"

#include <vector>

#include <lucent/cs2-finders/target.hpp>
#include <lucent/finder/target.hpp>

namespace lucent::facts {

// The one list of targets: a new target's finders library is linked and named here, and nowhere
// else in the generator.
auto linked_targets() -> std::vector<finder::target> {
    std::vector<finder::target> targets;
    targets.push_back(finder::cs2_target());
    return targets;
}

}
