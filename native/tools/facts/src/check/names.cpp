#include "check/names.hpp"

#include <algorithm>
#include <cstddef>
#include <filesystem>
#include <iterator>
#include <print>
#include <span>
#include <vector>

#include <lucent/finder/fact_search.hpp>
#include <lucent/finder/target.hpp>
#include <lucent/kit/fact.hpp>
#include <lucent/os/file.hpp>

#include "generate/manifest.hpp"

namespace lucent::facts {
namespace {

auto is_searched(u64 key, const finder::target& target) -> bool {
    return std::ranges::any_of(target.searches, [&](const finder::fact_search& search) {
        return kit::fact_key_of(search.fact) == key;
    });
}

}

auto count_named_leaks(const std::filesystem::path& module, const finder::target& target)
    -> result<isize> {
    const std::vector<std::byte> image = LUCENT_TRY(os::read_file(module));
    const module_manifest linked = LUCENT_TRY(manifest_of(module));
    isize findings = 0;
    for (const kit::fact_record& record : linked.facts) {
        if (!is_searched(record.key, target)) {
            std::println(
                "  error: fact {:#018x} is linked, but no {} search names it, so its name can't "
                "be checked",
                record.key,
                target.name
            );
            ++findings;
        }
    }
    // Names are UTF-8 literals in the declarations; that is the spelling that would ship.
    for (const finder::fact_search& search : target.searches) {
        const auto found = std::ranges::search(image, std::as_bytes(std::span{search.fact}));
        if (!found.empty()) {
            std::println(
                "  error: the image holds the fact name {} at file offset {:#x}",
                search.fact,
                std::distance(image.begin(), found.begin())
            );
            ++findings;
        }
    }
    return findings;
}

}
