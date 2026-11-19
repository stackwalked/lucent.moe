#pragma once

#include <filesystem>

#include <lucent/finder/target.hpp>

namespace lucent::facts {

// The release gate's name half, run after a release module links: every fact the module links must
// be one the target searches, so its name is known, and no searched fact's name may appear in the
// image's bytes. Prints each finding; answers how many there were.
auto count_named_leaks(const std::filesystem::path& module, const finder::target& target)
    -> result<isize>;

}
