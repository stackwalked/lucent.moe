#include "targets/linked.hpp"

#include <vector>

#include <lucent/cs2-finders/target.hpp>
#include <lucent/finders/target.hpp>

namespace lucent::factgen {

// The one list of targets: a new target's finders library is linked and named here, and nowhere
// else in the generator.
auto linked_targets() -> std::vector<finders::target> {
    std::vector<finders::target> targets;
    targets.push_back(finders::cs2_target());
    return targets;
}

}
